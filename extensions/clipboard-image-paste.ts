import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { matchesKey } from "@earendil-works/pi-tui";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ImageBlock = {
	type: "image";
	data: string;
	mimeType: string;
};

type PendingImage = {
	id: number;
	placeholder: string;
	mediaType: string;
	data: string;
	insertedAt: number;
};

let nextImageId = 1;
let pendingImages: PendingImage[] = [];

type ClipboardPasteContext = {
	cwd: string;
	ui: {
		pasteToEditor(text: string): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		getEditorText(): string;
		setEditorText(text: string): void;
		setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	};
};

async function readWindowsClipboardImage(): Promise<string> {
	const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { Write-Error "Clipboard does not contain an image"; exit 2 }
$stream = New-Object System.IO.MemoryStream
try {
  $img.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($stream.ToArray())
} finally {
  $stream.Dispose()
  $img.Dispose()
}
`;

	const { stdout } = await execFileAsync(
		"powershell.exe",
		[
			"-NoProfile",
			"-STA",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
		],
		{ maxBuffer: 100 * 1024 * 1024 },
	);
	return stdout.trim();
}

async function readMacClipboardImage(): Promise<string> {
	const jxa = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function base64(data) {
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}
function main() {
  const pb = $.NSPasteboard.generalPasteboard;

  const pngData = pb.dataForType('public.png');
  if (pngData && pngData.length > 0) return base64(pngData);

  const image = $.NSImage.alloc.initWithPasteboard(pb);
  if (!image || !image.isValid) throw new Error('Clipboard does not contain an image');

  const tiffData = image.TIFFRepresentation;
  if (!tiffData) throw new Error('Clipboard image has no TIFF representation');
  const bitmap = $.NSBitmapImageRep.imageRepWithData(tiffData);
  if (!bitmap) throw new Error('Could not create bitmap representation from clipboard image');
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (!png) throw new Error('Could not encode clipboard image as PNG');
  return base64(png);
}
main();
`;

	const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], {
		maxBuffer: 100 * 1024 * 1024,
	});
	return stdout.trim();
}

async function readClipboardImage(): Promise<string> {
	if (process.platform === "win32") {
		return readWindowsClipboardImage();
	}
	if (process.platform === "darwin") {
		return readMacClipboardImage();
	}
	throw new Error("Clipboard image paste is currently implemented for Windows and macOS only.");
}

async function readClipboardText(): Promise<string> {
	if (process.platform === "win32") {
		const { stdout } = await execFileAsync("powershell.exe", [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			"Get-Clipboard -Raw",
		]);
		return stdout;
	}
	if (process.platform === "darwin") {
		const { stdout } = await execFileAsync("pbpaste", []);
		return stdout;
	}
	throw new Error("Clipboard text paste fallback is currently implemented for Windows and macOS only.");
}

function imageBlock(image: PendingImage): ImageBlock {
	return {
		type: "image",
		data: image.data,
		mimeType: image.mediaType,
	};
}

function isCtrlV(data: string): boolean {
	return data === "\x16" || matchesKey(data, "ctrl+v");
}

function isPasteCommandShortcut(data: string): boolean {
	// Some terminals surface menu/clipboard-history paste shortcuts as Alt+V rather
	// than Ctrl+V. The Command key itself is usually handled by the terminal/OS and
	// does not reach the TUI, but this catches terminals that forward the Alt part.
	return matchesKey(data, "alt+v");
}

const BRACKETED_PASTE_START_MARKERS = ["\x1b[200~", "[200~"] as const;
const BRACKETED_PASTE_END_MARKERS = ["\x1b[201~", "[201~"] as const;

type MarkerMatch = {
	index: number;
	marker: string;
};

function findFirstMarker(data: string, markers: readonly string[], fromIndex = 0): MarkerMatch | undefined {
	let first: MarkerMatch | undefined;
	for (const marker of markers) {
		const index = data.indexOf(marker, fromIndex);
		if (index !== -1 && (!first || index < first.index)) first = { index, marker };
	}
	return first;
}

function getCompleteBracketedPasteContent(data: string): string | undefined {
	const start = findFirstMarker(data, BRACKETED_PASTE_START_MARKERS);
	if (!start) return undefined;
	const contentStart = start.index + start.marker.length;
	const end = findFirstMarker(data, BRACKETED_PASTE_END_MARKERS, contentStart);
	if (!end) return undefined;
	return data.slice(contentStart, end.index);
}

function isDeleteKey(data: string): boolean {
	return matchesKey(data, "backspace") || matchesKey(data, "delete");
}

function looksLikeUnbracketedMultiLinePaste(data: string): boolean {
	return data.length > 1 && (data.includes("\r") || data.includes("\n"));
}

function normalizeTerminalPasteText(data: string): string {
	return data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function attachedImagesLines(): string[] | undefined {
	if (pendingImages.length === 0) return undefined;
	return ["Attached images:", ...pendingImages.map((image) => `- ${image.placeholder}`)];
}

function updateAttachedImagesWidget(ctx: ClipboardPasteContext): void {
	ctx.ui.setWidget("clipboard-image-paste-attached-images", attachedImagesLines(), { placement: "belowEditor" });
}

/** Paste editor text and force Pi to render mutations made by asynchronous terminal-input handlers. */
function pasteToEditor(ctx: ClipboardPasteContext, text: string): void {
	ctx.ui.pasteToEditor(text);
	// pasteToEditor mutates the editor but does not currently request a TUI render.
	// Re-applying this extension's widget is a public-API render trigger, including
	// when no images are attached and the widget remains absent.
	updateAttachedImagesWidget(ctx);
}

function removeTrailingImagePlaceholder(ctx: ClipboardPasteContext): boolean {
	const text = ctx.ui.getEditorText();
	const image = [...pendingImages]
		.sort((a, b) => b.placeholder.length - a.placeholder.length)
		.find((candidate) => text.endsWith(candidate.placeholder) || text.trimEnd().endsWith(candidate.placeholder));
	if (!image) return false;

	const trimmedLength = text.trimEnd().length;
	const trailingWhitespace = text.slice(trimmedLength);
	ctx.ui.setEditorText(text.slice(0, trimmedLength - image.placeholder.length) + trailingWhitespace);
	pendingImages = pendingImages.filter((candidate) => candidate !== image);
	updateAttachedImagesWidget(ctx);
	return true;
}

function attachImage(ctx: ClipboardPasteContext, data: string, mediaType = "image/png"): void {
	const imageId = nextImageId++;
	const placeholder = `[Image ${imageId}]`;
	pendingImages.push({ id: imageId, placeholder, mediaType, data, insertedAt: Date.now() });
	pasteToEditor(ctx, placeholder);
	ctx.ui.notify(attachedImagesLines()?.join("\n") ?? "Attached images:", "info");
}

function imageMediaType(path: string): string | undefined {
	const extension = path.split(".").pop()?.toLowerCase();
	if (extension === "png") return "image/png";
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	if (extension === "gif") return "image/gif";
	if (extension === "webp") return "image/webp";
	return undefined;
}

async function attachImagePath(ctx: ClipboardPasteContext, encodedPath: string): Promise<void> {
	try {
		const path = Buffer.from(encodedPath, "base64").toString("utf8");
		const mediaType = imageMediaType(path);
		if (!mediaType) throw new Error("Unsupported image file type");
		attachImage(ctx, (await readFile(path)).toString("base64"), mediaType);
	} catch (error) {
		ctx.ui.notify(`Could not attach dropped image: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function pasteFromClipboard(ctx: ClipboardPasteContext): Promise<void> {
	try {
		attachImage(ctx, await readClipboardImage());
	} catch (imageError) {
		try {
			const text = await readClipboardText();
			if (text.length > 0) {
				pasteToEditor(ctx, text);
				return;
			}
			ctx.ui.notify(
				`Clipboard does not contain readable image or text. Image error: ${imageError instanceof Error ? imageError.message : String(imageError)}`,
				"warning",
			);
		} catch (textError) {
			ctx.ui.notify(
				`Could not paste from clipboard. Image error: ${imageError instanceof Error ? imageError.message : String(imageError)}. Text error: ${textError instanceof Error ? textError.message : String(textError)}`,
				"error",
			);
		}
	}
}

export default function clipboardImagePaste(pi: ExtensionAPI) {
	let unsubscribeTerminalInput: (() => void) | undefined;
	let activeCtx: ClipboardPasteContext | undefined;

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		unsubscribeTerminalInput?.();
		let bracketedPasteBuffer: string | undefined;
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			const swathImage = data.match(/^\x1b\]777;swath-image=([A-Za-z0-9+/=]+)\x07$/);
			if (swathImage?.[1]) {
				void attachImagePath(ctx, swathImage[1]);
				return { consume: true };
			}

			// Fully take over Ctrl+V at the raw terminal-input layer, avoiding Pi's built-in
			// paste-image implementation and preserving text paste fallback ourselves.
			if (isCtrlV(data) || isPasteCommandShortcut(data)) {
				void pasteFromClipboard(ctx);
				return { consume: true };
			}

			if (isDeleteKey(data) && removeTrailingImagePlaceholder(ctx)) {
				return { consume: true };
			}

			// Some terminal frontends send paste text as one raw, unbracketed chunk.
			// Route multi-line chunks through Pi's editor paste path so they stay in a
			// single message and still use the compact large-paste display.
			if (looksLikeUnbracketedMultiLinePaste(data)) {
				pasteToEditor(ctx, normalizeTerminalPasteText(data));
				return { consume: true };
			}

			// Terminal/OS paste commands (including clipboard-history pickers such as
			// Cmd+Alt+V on macOS) often arrive as bracketed paste rather than as Ctrl+V.
			// Text pastes include content and should be left alone for Pi's editor. If the
			// bracketed paste is empty, treat it as a possible image-only paste command and
			// read the current OS clipboard image ourselves.
			const completePaste = getCompleteBracketedPasteContent(data);
			if (completePaste !== undefined) {
				if (completePaste.length === 0) {
					void pasteFromClipboard(ctx);
				} else {
					pasteToEditor(ctx, completePaste);
				}
				return { consume: true };
			}

			const pasteStart = findFirstMarker(data, BRACKETED_PASTE_START_MARKERS);
			if (pasteStart) {
				bracketedPasteBuffer = data.slice(pasteStart.index + pasteStart.marker.length);
				const end = findFirstMarker(bracketedPasteBuffer, BRACKETED_PASTE_END_MARKERS);
				if (end) {
					const pasteContent = bracketedPasteBuffer.slice(0, end.index);
					bracketedPasteBuffer = undefined;
					if (pasteContent.length === 0) {
						void pasteFromClipboard(ctx);
					} else {
						pasteToEditor(ctx, pasteContent);
					}
				}
				return { consume: true };
			}
			if (bracketedPasteBuffer !== undefined) {
				bracketedPasteBuffer += data;
				const end = findFirstMarker(bracketedPasteBuffer, BRACKETED_PASTE_END_MARKERS);
				if (end) {
					const pasteContent = bracketedPasteBuffer.slice(0, end.index);
					bracketedPasteBuffer = undefined;
					if (pasteContent.length === 0) {
						void pasteFromClipboard(ctx);
					} else {
						pasteToEditor(ctx, pasteContent);
					}
				}
				return { consume: true };
			}
			return undefined;
		});
	});

	pi.on("input", async () => {
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		if (pendingImages.length === 0) return;

		const text = event.prompt ?? "";
		const imagesForThisPrompt = pendingImages.filter((image) => text.includes(image.placeholder));

		// If the user deleted an image placeholder, do not attach that image to the prompt.
		pendingImages = pendingImages.filter((image) => !imagesForThisPrompt.includes(image) && text.includes(image.placeholder));
		if (activeCtx) updateAttachedImagesWidget(activeCtx);
		if (imagesForThisPrompt.length === 0) return;

		return {
			message: {
				customType: "clipboard-image-paste",
				display: false,
				content: [
					{
						type: "text" as const,
						text: imagesForThisPrompt.map((image) => `${image.placeholder}: attached clipboard image.`).join("\n"),
					},
					...imagesForThisPrompt.map(imageBlock),
				],
			},
		};
	});

	pi.on("session_shutdown", () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		activeCtx?.ui.setWidget("clipboard-image-paste-attached-images", undefined, { placement: "belowEditor" });
		activeCtx = undefined;
		pendingImages = [];
	});
}
