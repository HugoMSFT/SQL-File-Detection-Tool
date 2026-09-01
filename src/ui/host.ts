/**
 * The capability surface the native UI controller needs from its environment.
 *
 * The controller owns all of the product logic and none of the VS Code API.
 * Everything it cannot do in pure TypeScript — open a dialog, write the
 * clipboard, read a secret, sign in — arrives through this interface, which
 * `src/nativeView.ts` implements with the real `vscode` namespace and the tests
 * implement with plain objects.
 *
 * That split is what makes the security-relevant behaviour testable: a test can
 * assert that analysing a file never called `spawn`, never asked for a Python
 * interpreter and never handed a token to the renderer, because the only way to
 * do any of those things would be through a method declared here.
 */

export interface OpenDialogOptions {
    readonly folders: boolean;
    readonly many: boolean;
    readonly title: string;
}

/** Everything the controller needs that is not pure computation. */
export interface UiHost {
    readonly version: string;

    /** Absolute paths of the open workspace folders. */
    workspaceFolders(): readonly string[];
    /** Absolute path of the file in the active editor, when it is on disk. */
    activeFilePath(): string | undefined;
    /**
     * Why the active editor cannot be analysed natively, when it cannot.
     *
     * Virtual and remote schemes have no filesystem path for the native reader,
     * so the UI states that plainly instead of failing obscurely.
     */
    activeFileLimitation(): string | undefined;

    showOpenDialog(options: OpenDialogOptions): Promise<readonly string[] | undefined>;

    copyToClipboard(text: string): Promise<void>;
    openUntitledDocument(content: string, languageId: string): Promise<void>;
    openExternal(url: string): Promise<boolean>;
    saveTextFile(suggestedName: string, content: string): Promise<string | undefined>;

    showInformation(message: string): void;
    showWarning(message: string): void;
    showError(message: string): void;
    /** Append to the extension's output channel. Callers must pre-redact. */
    log(message: string): void;

    /** Persisted, non-sensitive preferences. */
    getPreference<T>(key: string, fallback: T): T;
    setPreference(key: string, value: unknown): Promise<void>;

    /** Reveal the wider editor panel. */
    openPanel(): Promise<void>;

    /** Monotonic clock, injected so performance assertions are deterministic. */
    now(): number;
}
