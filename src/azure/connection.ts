/**
 * The native Azure Storage connection.
 *
 * This replaces the loopback backend's Azure endpoints: the extension host
 * talks to Azure Storage itself, and the four supported ways of authenticating
 * live here.
 *
 *   * `vscode`           — a delegated Microsoft token from VS Code's built-in
 *                          authentication provider. Recommended, because the
 *                          extension never sees a long-lived secret and the
 *                          token is refreshed before it expires.
 *   * `sas`              — a shared access signature URL.
 *   * `connectionString` — an account key or SAS connection string, collected
 *                          through a masked input box.
 *   * `anonymous`        — public containers, no credential at all.
 *
 * Managed identity is deliberately absent. There is no managed identity in a
 * desktop editor process; offering one would be theatre. It remains a
 * deployment mode of the optional command line package and is documented as
 * such.
 *
 * Secret handling rules, enforced by the shape of this module:
 *
 *   * A credential lives in extension-host memory, and in `SecretStorage` only
 *     when the user explicitly opts in to remembering it.
 *   * No method returns a credential. {@link NativeAzureBridge.info} is the
 *     only thing the UI layer can observe, and it carries labels only.
 *   * Every error is passed through `redactAzure` before it is logged or shown.
 *   * Disconnecting, a failed refresh and disposal all clear everything,
 *     including anything remembered.
 *
 * `vscode` is not imported: the editor capabilities arrive through
 * {@link AuthEnvironment}, so every mode is testable with plain objects.
 */

import type { AzureAuthMode } from '../protocol';
import type { AzureBridge, AzureConnectionInfo } from '../ui/host';
import { ARM_SCOPES, STORAGE_SCOPES, expiryFromJwt, refreshDelayMs } from '../azureScopes';
import { AzureBlobBrowser, type BlobBrowser, type BlobCredential } from './blobBrowser';
import {
    AzureInputError,
    isValidAccountName,
    parseConnectionString,
    parseSasUrl,
    redactAzure,
    serviceUrlFor,
} from './storageUrl';

/** Key under which a remembered credential is stored. */
export const SECRET_KEY = 'sqlFileDetection.azure.credential';

export interface AuthToken {
    readonly accessToken: string;
    readonly expiresOnMs: number;
    readonly account?: string;
}

export interface PromptOptions {
    readonly title: string;
    readonly prompt: string;
    readonly password: boolean;
    readonly placeHolder?: string;
}

export interface SecretStore {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

/** A cancellable timer, injected so tests never wait on a real clock. */
export interface Timer {
    cancel(): void;
}

/** The editor capabilities the bridge needs. */
export interface AuthEnvironment {
    /**
     * A Microsoft session for *scopes*.
     *
     * `interactive` distinguishes the sign-in click from the silent refresh;
     * a silent call must resolve `undefined` rather than prompting.
     */
    getSession(scopes: string[], interactive: boolean): Promise<AuthToken | undefined>;
    prompt(options: PromptOptions): Promise<string | undefined>;
    /** A yes/no question. Used only for the explicit "remember this" opt-in. */
    confirm(message: string, yes: string, no: string): Promise<boolean>;
    readonly secrets: SecretStore;
    log(message: string): void;
    now(): number;
    setTimer(callback: () => void, delayMs: number): Timer;
    /** Overridable so tests can observe the credential without a network. */
    createBrowser?(
        account: string,
        serviceUrl: string,
        credential: BlobCredential,
    ): BlobBrowser;
}

interface RememberedCredential {
    readonly mode: AzureAuthMode;
    readonly account: string;
    readonly serviceUrl: string;
    readonly sasToken?: string;
    readonly accountKey?: string;
}

const DISCONNECTED: AzureConnectionInfo = {
    connected: false,
    mode: null,
    identity: null,
    account: null,
    canListSubscriptions: false,
};

export class NativeAzureBridge implements AzureBridge {
    private state: AzureConnectionInfo = DISCONNECTED;
    private currentBrowser: BlobBrowser | undefined;
    /** In-memory only. Never returned, never logged, never serialised. */
    private credential: BlobCredential | undefined;
    private serviceSuffix = 'core.windows.net';
    private refreshTimer: Timer | undefined;
    private armExpiresOnMs = 0;
    private armAccessToken: string | undefined;

    constructor(private readonly env: AuthEnvironment) {}

    get info(): AzureConnectionInfo {
        return this.state;
    }

    browser(): BlobBrowser | undefined {
        return this.currentBrowser;
    }

    /**
     * Restore a remembered credential, if the user previously opted in.
     *
     * Called at activation. A failure here is never fatal: the user is simply
     * shown as disconnected and can connect again.
     */
    async restore(): Promise<AzureConnectionInfo> {
        let raw: string | undefined;
        try {
            raw = await this.env.secrets.get(SECRET_KEY);
        } catch {
            return this.state;
        }
        if (!raw) {
            return this.state;
        }
        try {
            const saved = JSON.parse(raw) as RememberedCredential;
            if (saved.mode === 'sas' && saved.sasToken) {
                this.attach(saved.account, saved.serviceUrl, {
                    kind: 'sas',
                    sasToken: saved.sasToken,
                });
            } else if (saved.mode === 'connectionString' && saved.accountKey) {
                this.attach(saved.account, saved.serviceUrl, {
                    kind: 'accountKey',
                    accountKey: saved.accountKey,
                });
            } else if (saved.mode === 'connectionString' && saved.sasToken) {
                this.attach(saved.account, saved.serviceUrl, {
                    kind: 'sas',
                    sasToken: saved.sasToken,
                });
            } else {
                await this.env.secrets.delete(SECRET_KEY);
                return this.state;
            }
            this.state = {
                connected: true,
                mode: saved.mode,
                identity: 'Remembered credential',
                account: saved.account,
                canListSubscriptions: false,
            };
            this.env.log(`Restored a remembered Azure credential for ${saved.account}.`);
        } catch {
            await this.env.secrets.delete(SECRET_KEY).catch(() => undefined);
        }
        return this.state;
    }

    async connect(mode: AzureAuthMode): Promise<AzureConnectionInfo> {
        switch (mode) {
            case 'vscode':
                return this.connectWithVsCodeAccount();
            case 'sas':
                return this.connectWithSas();
            case 'connectionString':
                return this.connectWithConnectionString();
            case 'anonymous':
                return this.connectAnonymously();
            default:
                throw new AzureInputError('That authentication mode is not supported.');
        }
    }

    async disconnect(): Promise<void> {
        this.cancelRefresh();
        this.credential = undefined;
        this.currentBrowser = undefined;
        this.armAccessToken = undefined;
        this.armExpiresOnMs = 0;
        this.state = DISCONNECTED;
        // A remembered credential is removed too: "disconnect" has to mean the
        // extension is no longer holding the user's key anywhere.
        await this.env.secrets.delete(SECRET_KEY).catch(() => undefined);
        this.env.log('Disconnected from Azure Storage and cleared any stored credential.');
    }

    /**
     * Point the existing credential at a different storage account.
     *
     * Only meaningful for a delegated token, which is account independent. A
     * SAS or an account key is scoped to one account, so switching is refused
     * rather than silently producing 403s.
     */
    async useAccount(account: string): Promise<AzureConnectionInfo> {
        if (!isValidAccountName(account)) {
            throw new AzureInputError('That is not a valid storage account name.');
        }
        if (!this.credential) {
            throw new AzureInputError('Connect to Azure before choosing an account.');
        }
        if (this.credential.kind !== 'token' && this.credential.kind !== 'anonymous') {
            if (this.state.account !== account) {
                throw new AzureInputError(
                    'This credential is scoped to a single storage account. Disconnect first to use a different one.',
                );
            }
            return this.state;
        }
        this.attach(account, serviceUrlFor(account, this.serviceSuffix), this.credential);
        this.state = { ...this.state, account };
        return this.state;
    }

    /**
     * A management-plane token, when one can be obtained silently.
     *
     * Subscription discovery is a convenience. Returning `undefined` simply
     * hides the picker; attaching to a known account still works.
     */
    async armToken(): Promise<string | undefined> {
        if (this.state.mode !== 'vscode') {
            return undefined;
        }
        if (this.armAccessToken && this.env.now() < this.armExpiresOnMs - 60_000) {
            return this.armAccessToken;
        }
        const session = await this.env.getSession(ARM_SCOPES, false).catch(() => undefined);
        if (!session) {
            this.armAccessToken = undefined;
            return undefined;
        }
        this.armAccessToken = session.accessToken;
        this.armExpiresOnMs = session.expiresOnMs;
        return this.armAccessToken;
    }

    dispose(): void {
        this.cancelRefresh();
        this.credential = undefined;
        this.currentBrowser = undefined;
        this.armAccessToken = undefined;
        this.state = DISCONNECTED;
    }

    // -- modes ---------------------------------------------------------------

    private async connectWithVsCodeAccount(): Promise<AzureConnectionInfo> {
        const session = await this.env.getSession(STORAGE_SCOPES, true);
        if (!session) {
            throw new AzureInputError('Azure sign-in was cancelled.');
        }
        this.credential = {
            kind: 'token',
            getToken: async () => {
                const fresh = await this.env.getSession(STORAGE_SCOPES, false);
                if (!fresh) {
                    throw new AzureInputError('The Azure session has expired. Connect again.');
                }
                return { token: fresh.accessToken, expiresOnMs: fresh.expiresOnMs };
            },
        };
        this.currentBrowser = undefined;
        const arm = await this.env.getSession(ARM_SCOPES, false).catch(() => undefined);
        if (arm) {
            this.armAccessToken = arm.accessToken;
            this.armExpiresOnMs = arm.expiresOnMs;
        }
        this.state = {
            connected: true,
            mode: 'vscode',
            identity: session.account ?? 'Microsoft account',
            account: null,
            canListSubscriptions: Boolean(arm),
        };
        this.scheduleRefresh(session.expiresOnMs);
        this.env.log(
            `Connected to Azure Storage as ${session.account ?? 'the signed-in Microsoft account'}.`,
        );
        return this.state;
    }

    private async connectWithSas(): Promise<AzureConnectionInfo> {
        const entered = await this.env.prompt({
            title: 'Azure Storage SAS URL',
            prompt: 'Paste the full https:// SAS URL, including the ?sv=... query.',
            password: true,
            placeHolder: 'https://account.blob.core.windows.net/container?sv=...',
        });
        if (entered === undefined) {
            throw new AzureInputError('Connecting with a SAS URL was cancelled.');
        }
        const parsed = parseSasUrl(entered);
        this.attach(parsed.account, parsed.serviceUrl, {
            kind: 'sas',
            sasToken: parsed.sasToken,
        });
        this.state = {
            connected: true,
            mode: 'sas',
            identity: 'Shared access signature',
            account: parsed.account,
            canListSubscriptions: false,
        };
        await this.offerToRemember({
            mode: 'sas',
            account: parsed.account,
            serviceUrl: parsed.serviceUrl,
            sasToken: parsed.sasToken,
        });
        this.env.log(`Connected to storage account ${parsed.account} with a SAS.`);
        return this.state;
    }

    private async connectWithConnectionString(): Promise<AzureConnectionInfo> {
        const entered = await this.env.prompt({
            title: 'Azure Storage connection string',
            prompt: 'The value is masked, is never written to settings, and is only stored if you choose to remember it.',
            password: true,
            placeHolder: 'DefaultEndpointsProtocol=https;AccountName=...',
        });
        if (entered === undefined) {
            throw new AzureInputError('Connecting with a connection string was cancelled.');
        }
        const parsed = parseConnectionString(entered);
        const credential: BlobCredential = parsed.accountKey
            ? { kind: 'accountKey', accountKey: parsed.accountKey }
            : { kind: 'sas', sasToken: parsed.sasToken as string };
        this.attach(parsed.account, parsed.serviceUrl, credential);
        this.state = {
            connected: true,
            mode: 'connectionString',
            identity: 'Connection string',
            account: parsed.account,
            canListSubscriptions: false,
        };
        await this.offerToRemember({
            mode: 'connectionString',
            account: parsed.account,
            serviceUrl: parsed.serviceUrl,
            accountKey: parsed.accountKey ?? undefined,
            sasToken: parsed.sasToken ?? undefined,
        });
        this.env.log(`Connected to storage account ${parsed.account} with a connection string.`);
        return this.state;
    }

    private async connectAnonymously(): Promise<AzureConnectionInfo> {
        const entered = await this.env.prompt({
            title: 'Public storage account',
            prompt: 'Storage account name. Only containers with public read access can be listed.',
            password: false,
            placeHolder: 'azureopendatastorage',
        });
        if (entered === undefined) {
            throw new AzureInputError('Connecting anonymously was cancelled.');
        }
        const account = entered.trim().toLowerCase();
        if (!isValidAccountName(account)) {
            throw new AzureInputError('That is not a valid storage account name.');
        }
        this.attach(account, serviceUrlFor(account, this.serviceSuffix), {
            kind: 'anonymous',
        });
        this.state = {
            connected: true,
            mode: 'anonymous',
            identity: 'Anonymous public access',
            account,
            canListSubscriptions: false,
        };
        this.env.log(`Browsing public containers on ${account} anonymously.`);
        return this.state;
    }

    // -- helpers -------------------------------------------------------------

    private attach(
        account: string,
        serviceUrl: string,
        credential: BlobCredential,
    ): void {
        this.credential = credential;
        this.currentBrowser = this.env.createBrowser
            ? this.env.createBrowser(account, serviceUrl, credential)
            : new AzureBlobBrowser(account, serviceUrl, credential);
    }

    /**
     * Ask, once, whether to keep the secret.
     *
     * Defaulting to "no" is the point: a connection string pasted for a one-off
     * look at a container should not silently become a stored secret.
     */
    private async offerToRemember(remembered: RememberedCredential): Promise<void> {
        let keep = false;
        try {
            keep = await this.env.confirm(
                'Remember this credential in the VS Code secret store for future sessions?',
                'Remember',
                'Just this session',
            );
        } catch {
            keep = false;
        }
        if (!keep) {
            await this.env.secrets.delete(SECRET_KEY).catch(() => undefined);
            return;
        }
        try {
            await this.env.secrets.store(SECRET_KEY, JSON.stringify(remembered));
            this.env.log('Stored the Azure credential in the VS Code secret store.');
        } catch (err) {
            this.env.log(`Could not store the credential: ${redactAzure(err)}`);
        }
    }

    private cancelRefresh(): void {
        this.refreshTimer?.cancel();
        this.refreshTimer = undefined;
    }

    /** Re-acquire the delegated token shortly before the current one expires. */
    private scheduleRefresh(expiresOnMs: number): void {
        this.cancelRefresh();
        const delay = refreshDelayMs(expiresOnMs, this.env.now());
        this.refreshTimer = this.env.setTimer(() => {
            void this.refresh();
        }, delay);
    }

    private async refresh(): Promise<void> {
        if (this.state.mode !== 'vscode') {
            return;
        }
        try {
            const session = await this.env.getSession(STORAGE_SCOPES, false);
            if (!session) {
                this.env.log('The Azure session is gone; disconnecting.');
                await this.disconnect();
                return;
            }
            const arm = await this.env.getSession(ARM_SCOPES, false).catch(() => undefined);
            this.armAccessToken = arm?.accessToken;
            this.armExpiresOnMs = arm?.expiresOnMs ?? 0;
            this.state = { ...this.state, canListSubscriptions: Boolean(arm) };
            this.scheduleRefresh(session.expiresOnMs);
        } catch (err) {
            this.env.log(`Azure token refresh failed: ${redactAzure(err)}`);
            await this.disconnect();
        }
    }
}

/** Expiry helper re-exported so callers need not reach into `azureScopes`. */
export { expiryFromJwt };
