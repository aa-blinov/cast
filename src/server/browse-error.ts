/** A folder-picker failure in words a person can act on, not the operating system's `ENOTEMPTY: …, rmdir '/very/long/path'`. */
export function browseErrorText(err: unknown): string {
	const code = (err as NodeJS.ErrnoException | null)?.code;
	switch (code) {
		case "ENOTEMPTY":
			return "The folder isn't empty, so it was not deleted";
		case "EACCES":
		case "EPERM":
			return "Permission denied";
		case "ENOENT":
			return "That folder doesn't exist";
		case "ENOTDIR":
			return "That is not a folder";
		case "EEXIST":
			return "A folder with that name already exists";
		default:
			return err instanceof Error ? err.message : String(err);
	}
}
