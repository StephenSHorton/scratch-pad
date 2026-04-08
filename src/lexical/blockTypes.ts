import { $createCodeNode } from "@lexical/code";
import {
	$createListItemNode,
	$createListNode,
	INSERT_ORDERED_LIST_COMMAND,
	INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
	$createParagraphNode,
	$createRangeSelection,
	$getNodeByKey,
	$isElementNode,
	$setSelection,
	type LexicalEditor,
} from "lexical";

// ---------------------------------------------------------------------------
// Shared block-type registry — used by SlashMenuPlugin and BlockHandlesPlugin
// ---------------------------------------------------------------------------

export type BlockTypeKey =
	| "paragraph"
	| "h1"
	| "h2"
	| "h3"
	| "ul"
	| "ol"
	| "quote"
	| "code";

export interface BlockTypeDef {
	key: BlockTypeKey;
	label: string;
	description: string;
	keywords: string[];
}

export const BLOCK_TYPES: readonly BlockTypeDef[] = [
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
// Filter logic — used by the slash menu typeahead
// ---------------------------------------------------------------------------
export function filterBlockTypes(query: string): BlockTypeDef[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return [...BLOCK_TYPES];
	return BLOCK_TYPES.filter((opt) => {
		if (opt.key.toLowerCase().includes(trimmed)) return true;
		return opt.keywords.some((kw) => kw.toLowerCase().includes(trimmed));
	});
}

// ---------------------------------------------------------------------------
// Convert a specific block (by key) into a different block type. This is
// used by the BlockHandlesPlugin "Turn into" submenu — unlike the slash menu
// which acts on the current selection, this acts on an arbitrary block.
//
// Approach: temporarily move the selection to the target block, run the same
// $setBlocksType / list command path the slash menu uses, then leave the
// selection there. Lexical's list commands operate on selection, so we have
// to set selection first.
// ---------------------------------------------------------------------------
export function convertBlockTo(
	editor: LexicalEditor,
	blockKey: string,
	type: BlockTypeKey,
): void {
	editor.update(() => {
		const node = $getNodeByKey(blockKey);
		if (!node) return;

		// Place selection inside the target block so $setBlocksType /
		// list commands operate on it.
		const range = $createRangeSelection();
		if ($isElementNode(node)) {
			range.anchor.set(node.getKey(), 0, "element");
			range.focus.set(node.getKey(), 0, "element");
		} else {
			range.anchor.set(node.getKey(), 0, "text");
			range.focus.set(node.getKey(), 0, "text");
		}
		$setSelection(range);

		switch (type) {
			case "paragraph":
				$setBlocksType(range, () => $createParagraphNode());
				break;
			case "h1":
				$setBlocksType(range, () => $createHeadingNode("h1"));
				break;
			case "h2":
				$setBlocksType(range, () => $createHeadingNode("h2"));
				break;
			case "h3":
				$setBlocksType(range, () => $createHeadingNode("h3"));
				break;
			case "quote":
				$setBlocksType(range, () => $createQuoteNode());
				break;
			case "code":
				$setBlocksType(range, () => $createCodeNode());
				break;
			case "ul":
				editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
				break;
			case "ol":
				editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
				break;
		}
	});
}

// Re-export create helpers used by the duplicate action — keeps imports tidy
export {
	$createParagraphNode,
	$createHeadingNode,
	$createQuoteNode,
	$createCodeNode,
	$createListNode,
	$createListItemNode,
};
