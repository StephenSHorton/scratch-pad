import { $createCodeNode } from "@lexical/code";
import {
	INSERT_ORDERED_LIST_COMMAND,
	INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	LexicalTypeaheadMenuPlugin,
	MenuOption,
	useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
	$createParagraphNode,
	$getSelection,
	$isRangeSelection,
	type TextNode,
} from "lexical";
import { type JSX, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// ---------------------------------------------------------------------------
// Slash menu options — block type conversions available via "/"
// ---------------------------------------------------------------------------
type SlashOptionKey =
	| "paragraph"
	| "h1"
	| "h2"
	| "h3"
	| "ul"
	| "ol"
	| "quote"
	| "code";

interface SlashOptionDef {
	key: SlashOptionKey;
	label: string;
	description: string;
	keywords: string[];
}

const SLASH_OPTIONS: readonly SlashOptionDef[] = [
	{
		key: "paragraph",
		label: "Text",
		description: "Plain text paragraph",
		keywords: ["paragraph", "text", "p"],
	},
	{
		key: "h1",
		label: "Heading 1",
		description: "Big section heading",
		keywords: ["h1", "heading", "title"],
	},
	{
		key: "h2",
		label: "Heading 2",
		description: "Medium section heading",
		keywords: ["h2", "heading"],
	},
	{
		key: "h3",
		label: "Heading 3",
		description: "Small section heading",
		keywords: ["h3", "heading"],
	},
	{
		key: "ul",
		label: "Bulleted list",
		description: "Simple bulleted list",
		keywords: ["ul", "bullet", "list"],
	},
	{
		key: "ol",
		label: "Numbered list",
		description: "Numbered list",
		keywords: ["ol", "ordered", "number", "list"],
	},
	{
		key: "quote",
		label: "Quote",
		description: "Block quote",
		keywords: ["quote", "blockquote"],
	},
	{
		key: "code",
		label: "Code",
		description: "Code block with syntax",
		keywords: ["code", "snippet"],
	},
];

// ---------------------------------------------------------------------------
// MenuOption subclass — carries the slash option definition
// ---------------------------------------------------------------------------
class SlashMenuOption extends MenuOption {
	def: SlashOptionDef;

	constructor(def: SlashOptionDef) {
		super(def.key);
		this.def = def;
	}
}

// ---------------------------------------------------------------------------
// Filter logic — match query against key + keywords (case insensitive,
// substring match). Empty query returns everything.
// ---------------------------------------------------------------------------
function filterOptions(query: string): SlashOptionDef[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return [...SLASH_OPTIONS];
	return SLASH_OPTIONS.filter((opt) => {
		if (opt.key.toLowerCase().includes(trimmed)) return true;
		return opt.keywords.some((kw) => kw.toLowerCase().includes(trimmed));
	});
}

// ---------------------------------------------------------------------------
// SlashMenuPlugin — drops a Notion/Linear-style block picker on "/"
// ---------------------------------------------------------------------------
export function SlashMenuPlugin(): JSX.Element | null {
	const [editor] = useLexicalComposerContext();
	const [query, setQuery] = useState<string | null>(null);

	// Use the built-in trigger that knows how to detect "/foo" at a word
	// boundary and gives us the matching string. allowWhitespace: false so the
	// menu closes the moment the user types a space.
	const triggerFn = useBasicTypeaheadTriggerMatch("/", {
		minLength: 0,
		allowWhitespace: false,
	});

	// Compute the visible options based on the current query.
	const options = useMemo<SlashMenuOption[]>(() => {
		const filtered = filterOptions(query ?? "");
		return filtered.map((def) => new SlashMenuOption(def));
	}, [query]);

	// Apply the chosen block transformation. Removes the "/query" text first
	// so the new block is empty and ready for input.
	const onSelectOption = useCallback(
		(
			selectedOption: SlashMenuOption,
			textNodeContainingQuery: TextNode | null,
			closeMenu: () => void,
		) => {
			editor.update(() => {
				// Remove the "/query" text the user typed.
				if (textNodeContainingQuery !== null) {
					textNodeContainingQuery.remove();
				}

				const selection = $getSelection();
				if (!$isRangeSelection(selection)) {
					closeMenu();
					return;
				}

				switch (selectedOption.def.key) {
					case "paragraph":
						$setBlocksType(selection, () => $createParagraphNode());
						break;
					case "h1":
						$setBlocksType(selection, () => $createHeadingNode("h1"));
						break;
					case "h2":
						$setBlocksType(selection, () => $createHeadingNode("h2"));
						break;
					case "h3":
						$setBlocksType(selection, () => $createHeadingNode("h3"));
						break;
					case "quote":
						$setBlocksType(selection, () => $createQuoteNode());
						break;
					case "code":
						$setBlocksType(selection, () => $createCodeNode());
						break;
					case "ul":
						editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
						break;
					case "ol":
						editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
						break;
				}
			});
			closeMenu();
		},
		[editor],
	);

	return (
		<LexicalTypeaheadMenuPlugin<SlashMenuOption>
			onQueryChange={setQuery}
			onSelectOption={onSelectOption}
			triggerFn={triggerFn}
			options={options}
			menuRenderFn={(
				anchorElementRef,
				{ selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
			) => {
				if (anchorElementRef.current === null || options.length === 0) {
					return null;
				}
				return createPortal(
					<div
						className="lexical-slash-menu"
						style={{
							background: "rgba(255, 255, 255, 0.97)",
							border: "1px solid rgba(0, 0, 0, 0.1)",
							borderRadius: "6px",
							boxShadow: "0 4px 16px rgba(0, 0, 0, 0.15)",
							padding: "4px 0",
							minWidth: "180px",
							maxHeight: "240px",
							overflowY: "auto",
							fontSize: "11px",
							color: "#1a1a1a",
							zIndex: 1000,
						}}
					>
						{options.map((option, i) => (
							<div
								key={option.def.key}
								ref={(el) => {
									option.setRefElement(el);
								}}
								role="option"
								aria-selected={selectedIndex === i}
								onMouseEnter={() => setHighlightedIndex(i)}
								onMouseDown={(e) => {
									// Prevent editor blur — we want to keep focus.
									e.preventDefault();
									setHighlightedIndex(i);
									selectOptionAndCleanUp(option);
								}}
								style={{
									padding: "6px 12px",
									cursor: "pointer",
									background:
										i === selectedIndex
											? "rgba(0, 0, 0, 0.06)"
											: "transparent",
									display: "flex",
									flexDirection: "column",
									gap: "2px",
								}}
							>
								<div style={{ fontWeight: 600 }}>{option.def.label}</div>
								<div style={{ fontSize: "9px", opacity: 0.6 }}>
									{option.def.description}
								</div>
							</div>
						))}
					</div>,
					anchorElementRef.current,
				);
			}}
		/>
	);
}
