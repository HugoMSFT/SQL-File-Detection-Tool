SQL File Detection Tool - plain text sample
==============================================

This file exercises the 'text' detector path. It contains ASCII text
plus a few non-ASCII characters so that encoding detection has
something to work with: café (decomposed), café (composed),
日本語, Русский, Ελληνικά.

Lines are terminated with LF (0x0A), so SQL Server BULK INSERT needs
ROWTERMINATOR = '0x0a' rather than the Windows default.
