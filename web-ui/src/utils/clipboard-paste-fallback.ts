/**
 * Clipboard paste fallback for environments where the native paste event
 * delivers empty clipboardData (e.g., WSL2 where the system clipboard bridge
 * doesn't populate ClipboardEvent.clipboardData).
 *
 * When a paste event fires with no text content, this fallback reads from
 * the Clipboard API and inserts text at the cursor position, preserving
 * the existing selection behavior of a standard textarea paste.
 */
export function handleClipboardPasteFallback(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
	if (!event.clipboardData) {
		return;
	}
	const hasText =
		event.clipboardData.types.includes("text/plain") && event.clipboardData.getData("text/plain").length > 0;
	if (hasText) {
		return;
	}
	const hasFiles = event.clipboardData.types.includes("Files") || event.clipboardData.files.length > 0;
	if (hasFiles) {
		return;
	}
	if (typeof navigator?.clipboard?.readText !== "function") {
		return;
	}
	const textarea = event.currentTarget;
	event.preventDefault();
	void (async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (!text) {
				return;
			}
			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;
			const before = textarea.value.slice(0, start);
			const after = textarea.value.slice(end);
			const nativeInputEvent = new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text });
			// Use native setter to update the value so React's onChange fires
			const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			if (nativeSetter) {
				nativeSetter.call(textarea, before + text + after);
				textarea.dispatchEvent(nativeInputEvent);
				const cursor = start + text.length;
				textarea.setSelectionRange(cursor, cursor);
			}
		} catch {
			// Clipboard API not available or permission denied — nothing we can do.
		}
	})();
}
