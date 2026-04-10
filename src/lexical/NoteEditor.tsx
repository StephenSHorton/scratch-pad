import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import {
	$convertFromMarkdownString,
	$convertToMarkdownString,
	TRANSFORMERS,
} from "@lexical/markdown";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { BlockHandlesPlugin } from "./BlockHandlesPlugin";
import { SlashMenuPlugin } from "./SlashMenuPlugin";
import { $getRoot, type EditorState, type LexicalEditor } from "lexical";
import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

// ---------------------------------------------------------------------------
// Theme — maps Lexical node types to CSS classes (defined in src/index.css)
// ---------------------------------------------------------------------------
const noteTheme = {
	paragraph: "lexical-paragraph",
	quote: "lexical-quote",
	heading: {
		h1: "lexical-heading-h1",
		h2: "lexical-heading-h2",
		h3: "lexical-heading-h3",
		h4: "lexical-heading-h4",
		h5: "lexical-heading-h5",
		h6: "lexical-heading-h6",
	},
	list: {
		ul: "lexical-list-ul",
		ol: "lexical-list-ol",
		listitem: "lexical-list-item",
		nested: {
			listitem: "lexical-nested-list-item",
		},
	},
	link: "lexical-link",
	text: {
		bold: "lexical-text-bold",
		italic: "lexical-text-italic",
		underline: "lexical-text-underline",
		strikethrough: "lexical-text-strikethrough",
		code: "lexical-text-code",
	},
	code: "lexical-code",
	codeHighlight: {
		atrule: "lexical-token-attr",
		attr: "lexical-token-attr",
		boolean: "lexical-token-property",
		builtin: "lexical-token-selector",
		cdata: "lexical-token-comment",
		char: "lexical-token-selector",
		class: "lexical-token-function",
		"class-name": "lexical-token-function",
		comment: "lexical-token-comment",
		constant: "lexical-token-property",
		deleted: "lexical-token-property",
		doctype: "lexical-token-comment",
		entity: "lexical-token-operator",
		function: "lexical-token-function",
		important: "lexical-token-variable",
		inserted: "lexical-token-selector",
		keyword: "lexical-token-attr",
		namespace: "lexical-token-variable",
		number: "lexical-token-property",
		operator: "lexical-token-operator",
		prolog: "lexical-token-comment",
		property: "lexical-token-property",
		punctuation: "lexical-token-punctuation",
		regex: "lexical-token-variable",
		selector: "lexical-token-selector",
		string: "lexical-token-selector",
		symbol: "lexical-token-property",
		tag: "lexical-token-property",
		url: "lexical-token-operator",
		variable: "lexical-token-variable",
	},
};

export interface NoteEditorProps {
	body: string;
	editable: boolean;
	textColor: string;
	highlightBg?: string;
	dimColor?: string;
	onChange?: (newBody: string) => void;
	highlightPattern?: string | null;
	onDismissHighlight?: () => void;
}

// ---------------------------------------------------------------------------
// Plugin: keep editor.setEditable in sync with prop
// ---------------------------------------------------------------------------
function EditableSyncPlugin({ editable }: { editable: boolean }) {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		editor.setEditable(editable);
	}, [editor, editable]);
	return null;
}

// ---------------------------------------------------------------------------
// Plugin: when body prop changes from outside (e.g. backend update),
// reset the editor content. Skips updates while user is actively editing
// to avoid clobbering in-progress changes.
// ---------------------------------------------------------------------------
function ExternalBodySyncPlugin({
	body,
	editable,
}: { body: string; editable: boolean }) {
	const [editor] = useLexicalComposerContext();
	const lastSyncedRef = useRef<string>(body);

	useEffect(() => {
		if (editable) return; // user is editing, don't trample their work
		if (body === lastSyncedRef.current) return;
		lastSyncedRef.current = body;
		editor.update(() => {
			$convertFromMarkdownString(body, TRANSFORMERS);
		});
	}, [editor, body, editable]);

	return null;
}

// ---------------------------------------------------------------------------
// Plugin: on blur, serialize editor content to markdown and call onChange
// ---------------------------------------------------------------------------
function BlurSavePlugin({
	originalBody,
	onChange,
	editable,
}: {
	originalBody: string;
	onChange?: (newBody: string) => void;
	editable: boolean;
}) {
	const [editor] = useLexicalComposerContext();
	const editableRef = useRef(editable);
	const originalBodyRef = useRef(originalBody);
	const onChangeRef = useRef(onChange);

	useEffect(() => {
		editableRef.current = editable;
	}, [editable]);
	useEffect(() => {
		originalBodyRef.current = originalBody;
	}, [originalBody]);
	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	useEffect(() => {
		const rootEl = editor.getRootElement();
		if (!rootEl) return;

		const handleBlur = () => {
			if (!editableRef.current) return;
			let markdown = "";
			editor.getEditorState().read(() => {
				markdown = $convertToMarkdownString(TRANSFORMERS);
			});
			if (markdown !== originalBodyRef.current) {
				onChangeRef.current?.(markdown);
			} else {
				// Still notify so caller can flip the editing state off
				onChangeRef.current?.(markdown);
			}
		};

		rootEl.addEventListener("blur", handleBlur);
		return () => {
			rootEl.removeEventListener("blur", handleBlur);
		};
	}, [editor]);

	return null;
}

// ---------------------------------------------------------------------------
// Plugin: autofocus when editable becomes true
// ---------------------------------------------------------------------------
function AutoFocusOnEditPlugin({ editable }: { editable: boolean }) {
	const [editor] = useLexicalComposerContext();
	const wasEditableRef = useRef(editable);
	useEffect(() => {
		if (editable && !wasEditableRef.current) {
			editor.focus();
		}
		wasEditableRef.current = editable;
	}, [editor, editable]);
	return null;
}

// ---------------------------------------------------------------------------
// Plugin: track top-level block keys + their text content for highlighting
// ---------------------------------------------------------------------------
interface BlockInfo {
	key: string;
	text: string;
}

function BlockTrackerPlugin({
	onBlocksChange,
}: { onBlocksChange: (blocks: BlockInfo[]) => void }) {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		const compute = (state: EditorState) => {
			const blocks: BlockInfo[] = [];
			state.read(() => {
				const root = $getRoot();
				for (const child of root.getChildren()) {
					blocks.push({
						key: child.getKey(),
						text: child.getTextContent(),
					});
				}
			});
			onBlocksChange(blocks);
		};

		// Initial pass
		compute(editor.getEditorState());

		const unregister = editor.registerUpdateListener(({ editorState }) => {
			compute(editorState);
		});
		return unregister;
	}, [editor, onBlocksChange]);

	return null;
}

// ---------------------------------------------------------------------------
// Plugin: apply highlight CSS classes to top-level block DOM nodes
// ---------------------------------------------------------------------------
function HighlightDecoratorPlugin({
	pattern,
	blocks,
	onLastMatchKeyChange,
}: {
	pattern: string | null;
	blocks: BlockInfo[];
	onLastMatchKeyChange: (key: string | null) => void;
}) {
	const [editor] = useLexicalComposerContext();

	useLayoutEffect(() => {
		const matchKeys = new Set<string>();
		let lastMatchKey: string | null = null;

		if (pattern) {
			const lower = pattern.toLowerCase();
			for (const block of blocks) {
				if (block.text.toLowerCase().includes(lower)) {
					matchKeys.add(block.key);
					lastMatchKey = block.key;
				}
			}
		}

		// Apply classes to all currently-tracked blocks
		const cleanups: Array<() => void> = [];
		for (const block of blocks) {
			const el = editor.getElementByKey(block.key);
			if (!el) continue;
			if (!pattern) {
				el.classList.remove("lexical-block-match", "lexical-block-dim");
				continue;
			}
			if (matchKeys.has(block.key)) {
				el.classList.add("lexical-block-match");
				el.classList.remove("lexical-block-dim");
			} else {
				el.classList.add("lexical-block-dim");
				el.classList.remove("lexical-block-match");
			}
			cleanups.push(() => {
				el.classList.remove("lexical-block-match", "lexical-block-dim");
			});
		}

		onLastMatchKeyChange(lastMatchKey);

		return () => {
			for (const c of cleanups) c();
		};
	}, [editor, pattern, blocks, onLastMatchKeyChange]);

	return null;
}

// ---------------------------------------------------------------------------
// Inner component — needs to live inside LexicalComposer
// ---------------------------------------------------------------------------
function NoteEditorInner({
	body,
	editable,
	textColor,
	onChange,
	highlightPattern,
	onDismissHighlight,
}: NoteEditorProps) {
	const [editor] = useLexicalComposerContext();
	const [blocks, setBlocks] = useState<BlockInfo[]>([]);
	const [lastMatchKey, setLastMatchKey] = useState<string | null>(null);
	const [dismissBtnTop, setDismissBtnTop] = useState<number | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	// Position the "Got it" button below the last matching block.
	useLayoutEffect(() => {
		if (!highlightPattern || !lastMatchKey) {
			setDismissBtnTop(null);
			return;
		}
		const el = editor.getElementByKey(lastMatchKey);
		const container = containerRef.current;
		if (!el || !container) {
			setDismissBtnTop(null);
			return;
		}
		const elRect = el.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();
		// Position relative to container's content (account for scroll)
		setDismissBtnTop(
			elRect.bottom - containerRect.top + container.scrollTop + 6,
		);
	}, [editor, highlightPattern, lastMatchKey, blocks]);

	return (
		<div
			ref={containerRef}
			className="lexical-note-container"
			style={{
				flex: 1,
				position: "relative",
				overflowY: "auto",
				overflowX: "hidden",
				color: textColor,
				fontSize: "13px",
				lineHeight: 1.5,
				paddingLeft: editable ? "18px" : undefined,
				paddingRight: editable ? "18px" : "4px",
				wordBreak: "break-word",
				height: "100%",
				cursor: editable ? "text" : "grab",
			}}
		>
			<RichTextPlugin
				contentEditable={
					<ContentEditable
						className="lexical-content-editable"
						style={{
							outline: "none",
							minHeight: "100%",
							// When not editable, let pointer events fall through to parent
							// so window dragging works.
							pointerEvents: editable ? "auto" : "none",
							userSelect: editable ? "text" : "none",
							color: textColor,
						}}
					/>
				}
				ErrorBoundary={LexicalErrorBoundary}
			/>
			<HistoryPlugin />
			<ListPlugin />
			<MarkdownShortcutPlugin transformers={TRANSFORMERS} />
			{editable && <SlashMenuPlugin />}
			{editable && (
				<BlockHandlesPlugin
					editable={editable}
					textColor={textColor}
					containerRef={containerRef}
				/>
			)}
			<EditableSyncPlugin editable={editable} />
			<ExternalBodySyncPlugin body={body} editable={editable} />
			<AutoFocusOnEditPlugin editable={editable} />
			<BlurSavePlugin
				originalBody={body}
				onChange={onChange}
				editable={editable}
			/>
			<BlockTrackerPlugin onBlocksChange={setBlocks} />
			<HighlightDecoratorPlugin
				pattern={highlightPattern ?? null}
				blocks={blocks}
				onLastMatchKeyChange={setLastMatchKey}
			/>
			{highlightPattern && lastMatchKey && dismissBtnTop !== null && (
				<button
					type="button"
					onClick={onDismissHighlight}
					onMouseDown={(e) => e.stopPropagation()}
					style={{
						position: "absolute",
						top: `${dismissBtnTop}px`,
						left: 0,
						background: textColor,
						color: "#fff",
						border: "none",
						borderRadius: "4px",
						padding: "4px 12px",
						fontSize: "10px",
						fontWeight: 600,
						cursor: "pointer",
						boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
						pointerEvents: "auto",
						zIndex: 10,
					}}
				>
					Got it
				</button>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Outer component — sets up LexicalComposer with initial state
// ---------------------------------------------------------------------------
export function NoteEditor(props: NoteEditorProps) {
	// Re-key the composer when body identity changes drastically (e.g. switching notes).
	// We use the body's first sync as the seed; subsequent updates flow through
	// ExternalBodySyncPlugin so we don't lose history.
	const initialConfig = useMemo(
		() => ({
			namespace: "ScratchPadNote",
			theme: noteTheme,
			editable: props.editable,
			onError: (error: Error) => {
				console.error("[Lexical]", error);
			},
			nodes: [
				HeadingNode,
				QuoteNode,
				ListNode,
				ListItemNode,
				CodeNode,
				CodeHighlightNode,
				LinkNode,
			],
			editorState: (editor: LexicalEditor) => {
				editor.update(() => {
					$convertFromMarkdownString(props.body ?? "", TRANSFORMERS);
				});
			},
		}),
		// Intentionally only depend on a stable seed: we don't want to reinit
		// every time `body` changes — ExternalBodySyncPlugin handles that.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	return (
		<LexicalComposer initialConfig={initialConfig}>
			<NoteEditorInner {...props} />
		</LexicalComposer>
	);
}
