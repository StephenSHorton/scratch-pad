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
import { type BlockTypeDef, filterBlockTypes } from "./blockTypes";

// ---------------------------------------------------------------------------
// MenuOption subclass — carries the shared block-type definition
// ---------------------------------------------------------------------------
class SlashMenuOption extends MenuOption {
	def: BlockTypeDef;

	constructor(def: BlockTypeDef) {
		super(def.key);
		this.def = def;
	}
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
		const filtered = filterBlockTypes(query ?? "");
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
