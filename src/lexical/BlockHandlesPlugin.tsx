import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { AnimatePresence, motion } from "motion/react";
import {
	$getNodeByKey,
	$getRoot,
	type EditorState,
	type LexicalNode,
} from "lexical";
import {
	type CSSProperties,
	type JSX,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { BLOCK_TYPES, type BlockTypeKey, convertBlockTo } from "./blockTypes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlockGeometry {
	key: string;
	top: number;
	height: number;
	width: number;
}

interface ActiveBlockSnapshot {
	html: string;
	width: number;
	height: number;
	className: string;
}

interface ContextMenuState {
	blockKey: string;
	x: number;
	y: number;
	view: "main" | "turnInto";
}

// ---------------------------------------------------------------------------
// Drag handle icon — Notion-style two-column dots
// ---------------------------------------------------------------------------
function HandleIcon(): JSX.Element {
	return (
		<svg
			width="10"
			height="14"
			viewBox="0 0 10 14"
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
		>
			<circle cx="2.5" cy="3" r="1.1" />
			<circle cx="2.5" cy="7" r="1.1" />
			<circle cx="2.5" cy="11" r="1.1" />
			<circle cx="7.5" cy="3" r="1.1" />
			<circle cx="7.5" cy="7" r="1.1" />
			<circle cx="7.5" cy="11" r="1.1" />
		</svg>
	);
}

// ---------------------------------------------------------------------------
// Sortable handle item — one per top-level block. Absolutely positioned over
// the editor's gutter so the handle floats next to its block.
// ---------------------------------------------------------------------------
interface SortableHandleProps {
	blockKey: string;
	top: number;
	height: number;
	textColor: string;
	hoveredKey: string | null;
	onHoverChange: (key: string | null) => void;
	onOpenMenu: (key: string, x: number, y: number) => void;
}

function SortableHandle({
	blockKey,
	top,
	height,
	textColor,
	hoveredKey,
	onHoverChange,
	onOpenMenu,
}: SortableHandleProps): JSX.Element {
	const [editor] = useLexicalComposerContext();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: blockKey });

	// Apply dnd-kit's transform/transition to the actual Lexical block element
	// so the block visually slides as other items shift around it during drag.
	useLayoutEffect(() => {
		const el = editor.getElementByKey(blockKey);
		if (!el) return;
		if (transform && !isDragging) {
			el.style.transform = CSS.Translate.toString(transform) ?? "";
			el.style.transition = transition ?? "";
		} else {
			el.style.transform = "";
			el.style.transition = "";
		}
		return () => {
			if (el) {
				el.style.transform = "";
				el.style.transition = "";
			}
		};
	}, [editor, blockKey, transform, transition, isDragging]);

	// Hide the original Lexical block while it's being dragged — the DragOverlay
	// will show a faithful copy following the cursor.
	useLayoutEffect(() => {
		const el = editor.getElementByKey(blockKey);
		if (!el) return;
		if (isDragging) {
			el.style.opacity = "0.15";
			el.style.background = "rgba(0, 0, 0, 0.04)";
			el.style.borderRadius = "6px";
		} else {
			el.style.opacity = "";
			el.style.background = "";
			el.style.borderRadius = "";
		}
		return () => {
			if (el) {
				el.style.opacity = "";
				el.style.background = "";
				el.style.borderRadius = "";
			}
		};
	}, [editor, blockKey, isDragging]);

	// Position the handle in the gutter to the LEFT of the block.
	// Aligned flex-start so the icon hugs the left edge of the overlay.
	const style: CSSProperties = {
		position: "absolute",
		left: 0,
		top,
		height,
		width: 14,
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "flex-start",
		paddingTop: Math.max(0, Math.min(6, height / 2 - 7)),
		pointerEvents: "auto",
		// While dragging, the dnd-kit transform on the handle would chase the
		// cursor; we hide the handle entirely since DragOverlay shows the preview.
		transform: isDragging ? "" : CSS.Translate.toString(transform),
		transition,
		zIndex: isDragging ? 100 : 50,
		opacity: isDragging ? 0 : 1,
	};

	const isHovered = hoveredKey === blockKey;

	// Track mouse-down vs click on the handle so we can distinguish
	// "clicked to open menu" from "started dragging".
	const downPosRef = useRef<{ x: number; y: number; t: number } | null>(null);
	const draggedRef = useRef(false);

	// dnd-kit listeners include onPointerDown — wrap it so we can also record
	// our own state for click detection.
	const listenersWithGuard = useMemo(() => {
		if (!listeners) return undefined;
		return {
			...listeners,
			onPointerDown: (e: React.PointerEvent) => {
				downPosRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
				draggedRef.current = false;
				listeners.onPointerDown?.(e);
			},
		};
	}, [listeners]);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			// If a drag actually happened, dnd-kit will have prevented the click
			// (or we set draggedRef). Skip the menu in that case.
			if (draggedRef.current) return;
			e.preventDefault();
			e.stopPropagation();
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			onOpenMenu(blockKey, rect.right + 4, rect.top);
		},
		[blockKey, onOpenMenu],
	);

	return (
		<div
			ref={setNodeRef}
			style={style}
			onMouseEnter={() => onHoverChange(blockKey)}
			onMouseLeave={() => onHoverChange(null)}
			onMouseDown={(e) => {
				// Prevent the StickyNote container's window-drag handler from
				// firing when the user grabs a handle.
				e.stopPropagation();
			}}
		>
			<button
				type="button"
				{...attributes}
				{...listenersWithGuard}
				onClick={handleClick}
				aria-label="Block actions"
				title="Drag to reorder, click for actions"
				style={{
					background: "transparent",
					border: "none",
					padding: "2px 2px",
					margin: 0,
					color: textColor,
					opacity: isHovered ? 0.9 : 0,
					cursor: isDragging ? "grabbing" : "grab",
					transition: "opacity 0.15s ease",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					borderRadius: 3,
					lineHeight: 0,
					touchAction: "none",
				}}
			>
				<HandleIcon />
			</button>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Context menu — opens next to a clicked handle
// ---------------------------------------------------------------------------
interface BlockContextMenuProps {
	state: ContextMenuState;
	textColor: string;
	canDelete: boolean;
	onClose: () => void;
	onTurnInto: (type: BlockTypeKey) => void;
	onDuplicate: () => void;
	onDelete: () => void;
	onShowTurnInto: () => void;
	onBack: () => void;
}

function BlockContextMenu({
	state,
	canDelete,
	onClose,
	onTurnInto,
	onDuplicate,
	onDelete,
	onShowTurnInto,
	onBack,
}: BlockContextMenuProps): JSX.Element {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleDocClick = (e: MouseEvent) => {
			if (!ref.current) return;
			if (!ref.current.contains(e.target as Node)) onClose();
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				if (state.view === "turnInto") onBack();
				else onClose();
			}
		};
		document.addEventListener("mousedown", handleDocClick);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleDocClick);
			document.removeEventListener("keydown", handleKey);
		};
	}, [state.view, onClose, onBack]);

	const baseStyle: CSSProperties = {
		position: "fixed",
		left: state.x,
		top: state.y,
		background: "rgba(255, 255, 255, 0.97)",
		border: "1px solid rgba(0, 0, 0, 0.1)",
		borderRadius: 6,
		boxShadow: "0 4px 16px rgba(0, 0, 0, 0.15)",
		padding: "4px 0",
		minWidth: 160,
		fontSize: 11,
		color: "#1a1a1a",
		zIndex: 1000,
	};

	const itemStyle: CSSProperties = {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		padding: "6px 12px",
		cursor: "pointer",
		userSelect: "none",
	};

	const sectionLabel: CSSProperties = {
		padding: "4px 12px 2px",
		fontSize: 9,
		textTransform: "uppercase",
		letterSpacing: "0.5px",
		opacity: 0.5,
	};

	return (
		<motion.div
			ref={ref}
			role="menu"
			initial={{ opacity: 0, scale: 0.96, y: -2 }}
			animate={{ opacity: 1, scale: 1, y: 0 }}
			exit={{ opacity: 0, scale: 0.96, y: -2 }}
			transition={{ duration: 0.1, ease: "easeOut" }}
			style={baseStyle}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{state.view === "main" ? (
				<>
					<div
						role="menuitem"
						style={itemStyle}
						onClick={onShowTurnInto}
						onMouseEnter={(e) =>
							(e.currentTarget.style.background = "rgba(0, 0, 0, 0.06)")
						}
						onMouseLeave={(e) =>
							(e.currentTarget.style.background = "transparent")
						}
					>
						<span>Turn into</span>
						<span style={{ opacity: 0.5 }}>{"\u203A"}</span>
					</div>
					<div
						role="menuitem"
						style={itemStyle}
						onClick={onDuplicate}
						onMouseEnter={(e) =>
							(e.currentTarget.style.background = "rgba(0, 0, 0, 0.06)")
						}
						onMouseLeave={(e) =>
							(e.currentTarget.style.background = "transparent")
						}
					>
						<span>Duplicate</span>
					</div>
					<div
						role="menuitem"
						aria-disabled={!canDelete}
						style={{
							...itemStyle,
							color: canDelete ? "#dc2626" : "rgba(220, 38, 38, 0.4)",
							cursor: canDelete ? "pointer" : "not-allowed",
						}}
						onClick={() => {
							if (canDelete) onDelete();
						}}
						onMouseEnter={(e) => {
							if (canDelete)
								e.currentTarget.style.background = "rgba(220, 38, 38, 0.08)";
						}}
						onMouseLeave={(e) =>
							(e.currentTarget.style.background = "transparent")
						}
					>
						<span>Delete</span>
					</div>
				</>
			) : (
				<>
					<div
						role="menuitem"
						style={{ ...itemStyle, opacity: 0.7 }}
						onClick={onBack}
						onMouseEnter={(e) =>
							(e.currentTarget.style.background = "rgba(0, 0, 0, 0.06)")
						}
						onMouseLeave={(e) =>
							(e.currentTarget.style.background = "transparent")
						}
					>
						<span>{"\u2039"} Back</span>
					</div>
					<div style={sectionLabel}>Turn into</div>
					{BLOCK_TYPES.map((bt) => (
						<div
							key={bt.key}
							role="menuitem"
							style={itemStyle}
							onClick={() => onTurnInto(bt.key)}
							onMouseEnter={(e) =>
								(e.currentTarget.style.background = "rgba(0, 0, 0, 0.06)")
							}
							onMouseLeave={(e) =>
								(e.currentTarget.style.background = "transparent")
							}
						>
							<span>{bt.label}</span>
						</div>
					))}
				</>
			)}
		</motion.div>
	);
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------
export interface BlockHandlesPluginProps {
	editable: boolean;
	textColor: string;
	containerRef: React.RefObject<HTMLDivElement | null>;
}

export function BlockHandlesPlugin({
	editable,
	textColor,
	containerRef,
}: BlockHandlesPluginProps): JSX.Element | null {
	const [editor] = useLexicalComposerContext();
	const [blockKeys, setBlockKeys] = useState<string[]>([]);
	const [geometries, setGeometries] = useState<BlockGeometry[]>([]);
	const [hoveredKey, setHoveredKey] = useState<string | null>(null);
	const [activeSnapshot, setActiveSnapshot] = useState<ActiveBlockSnapshot | null>(null);
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const overlayRef = useRef<HTMLDivElement>(null);

	// Track block keys from the editor's root.
	useEffect(() => {
		const compute = (state: EditorState) => {
			state.read(() => {
				const root = $getRoot();
				const keys: string[] = [];
				for (const child of root.getChildren()) {
					keys.push(child.getKey());
				}
				setBlockKeys((prev) => {
					if (
						prev.length === keys.length &&
						prev.every((k, i) => k === keys[i])
					)
						return prev;
					return keys;
				});
			});
		};
		compute(editor.getEditorState());
		return editor.registerUpdateListener(({ editorState }) => {
			compute(editorState);
		});
	}, [editor]);

	// Measure DOM positions of every tracked block whenever blocks/container
	// change. Re-measures on resize too.
	const measure = useCallback(() => {
		const container = containerRef.current;
		if (!container) {
			setGeometries([]);
			return;
		}
		const containerRect = container.getBoundingClientRect();
		const next: BlockGeometry[] = [];
		for (const key of blockKeys) {
			const el = editor.getElementByKey(key);
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			next.push({
				key,
				top: rect.top - containerRect.top + container.scrollTop,
				height: rect.height,
				width: rect.width,
			});
		}
		setGeometries(next);
	}, [editor, blockKeys, containerRef]);

	useLayoutEffect(() => {
		measure();
	}, [measure]);

	// Re-measure on container resize / scroll / window resize so the handles
	// stay aligned with the blocks.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const ro = new ResizeObserver(() => measure());
		ro.observe(container);
		// Also observe each tracked block element so font/size shifts re-measure.
		for (const key of blockKeys) {
			const el = editor.getElementByKey(key);
			if (el) ro.observe(el);
		}
		const handleScroll = () => measure();
		container.addEventListener("scroll", handleScroll);
		window.addEventListener("resize", handleScroll);
		return () => {
			ro.disconnect();
			container.removeEventListener("scroll", handleScroll);
			window.removeEventListener("resize", handleScroll);
		};
	}, [editor, blockKeys, containerRef, measure]);

	// Hover detection — track which block the cursor is over so the handle
	// fades in even when hovering the block itself (not just the gutter).
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const onMouseMove = (e: MouseEvent) => {
			const containerRect = container.getBoundingClientRect();
			const localY = e.clientY - containerRect.top + container.scrollTop;
			let found: string | null = null;
			for (const g of geometries) {
				if (localY >= g.top && localY <= g.top + g.height) {
					found = g.key;
					break;
				}
			}
			setHoveredKey((prev) => (prev === found ? prev : found));
		};
		const onMouseLeave = () => setHoveredKey(null);
		container.addEventListener("mousemove", onMouseMove);
		container.addEventListener("mouseleave", onMouseLeave);
		return () => {
			container.removeEventListener("mousemove", onMouseMove);
			container.removeEventListener("mouseleave", onMouseLeave);
		};
	}, [containerRef, geometries]);

	// dnd-kit sensors — pointer with a small activation distance so a click
	// without movement opens the menu rather than triggering a drag.
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 5 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			const id = String(event.active.id);
			setMenu(null);
			// Snapshot the live DOM of the dragged block so we can render a faithful
			// preview in the DragOverlay (same content, same dimensions, same styles).
			const el = editor.getElementByKey(id);
			if (el) {
				const rect = el.getBoundingClientRect();
				setActiveSnapshot({
					html: el.innerHTML,
					width: rect.width,
					height: rect.height,
					className: el.className,
				});
			}
		},
		[editor],
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			setActiveSnapshot(null);
			if (!over || active.id === over.id) return;

			const fromIdx = blockKeys.indexOf(String(active.id));
			const toIdx = blockKeys.indexOf(String(over.id));
			if (fromIdx === -1 || toIdx === -1) return;

			// Optimistically reorder local state so the handle overlay animates
			// smoothly while Lexical applies its update.
			const newOrder = arrayMove(blockKeys, fromIdx, toIdx);
			setBlockKeys(newOrder);

			editor.update(() => {
				const root = $getRoot();
				const childrenByKey = new Map<string, LexicalNode>();
				for (const child of root.getChildren()) {
					childrenByKey.set(child.getKey(), child);
				}
				// Detach all in current order, re-append in new order.
				for (const child of root.getChildren()) {
					child.remove();
				}
				for (const key of newOrder) {
					const node = childrenByKey.get(key);
					if (node) root.append(node);
				}
			});
		},
		[blockKeys, editor],
	);

	const handleDragCancel = useCallback(() => {
		setActiveSnapshot(null);
	}, []);

	const closeMenu = useCallback(() => setMenu(null), []);

	const openMenu = useCallback((key: string, x: number, y: number) => {
		setMenu({ blockKey: key, x, y, view: "main" });
	}, []);

	const handleTurnInto = useCallback(
		(type: BlockTypeKey) => {
			if (!menu) return;
			convertBlockTo(editor, menu.blockKey, type);
			setMenu(null);
		},
		[editor, menu],
	);

	const handleDuplicate = useCallback(() => {
		if (!menu) return;
		const targetKey = menu.blockKey;
		editor.update(() => {
			const node = $getNodeByKey(targetKey);
			if (!node) return;
			// Round-trip via JSON for a deep clone that handles nested structure.
			try {
				const json = node.exportJSON();
				const NodeClass = node.constructor as unknown as {
					importJSON?: (data: unknown) => LexicalNode;
				};
				if (typeof NodeClass.importJSON === "function") {
					const clone = NodeClass.importJSON(json);
					node.insertAfter(clone);
				}
			} catch (err) {
				console.warn("[BlockHandles] duplicate failed", err);
			}
		});
		setMenu(null);
	}, [editor, menu]);

	const handleDelete = useCallback(() => {
		if (!menu) return;
		const targetKey = menu.blockKey;
		editor.update(() => {
			const root = $getRoot();
			if (root.getChildrenSize() <= 1) return; // never delete the last block
			const node = $getNodeByKey(targetKey);
			if (node) node.remove();
		});
		setMenu(null);
	}, [editor, menu]);

	if (!editable) return null;

	const items = blockKeys;

	return (
		<>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
				onDragCancel={handleDragCancel}
			>
				<SortableContext
					items={items}
					strategy={verticalListSortingStrategy}
				>
					<div
						ref={overlayRef}
						className="lexical-block-handles-overlay"
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: 18,
							height: "100%",
							pointerEvents: "none",
							zIndex: 30,
						}}
					>
						{geometries.map((g) => (
							<SortableHandle
								key={g.key}
								blockKey={g.key}
								top={g.top}
								height={g.height}
								textColor={textColor}
								hoveredKey={hoveredKey}
								onHoverChange={setHoveredKey}
								onOpenMenu={openMenu}
							/>
						))}
					</div>
				</SortableContext>
				<DragOverlay dropAnimation={{ duration: 180, easing: "ease-out" }}>
					{activeSnapshot ? (
						<div
							className={activeSnapshot.className}
							style={{
								width: activeSnapshot.width,
								minHeight: activeSnapshot.height,
								background: "rgba(255, 255, 255, 0.96)",
								border: "1px solid rgba(0, 0, 0, 0.08)",
								borderRadius: 6,
								boxShadow: "0 12px 32px rgba(0, 0, 0, 0.2)",
								color: textColor,
								fontSize: 13,
								lineHeight: 1.5,
								pointerEvents: "none",
								cursor: "grabbing",
								// Slight scale to show "lifted" state
								transform: "scale(1.02)",
							}}
							// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted source — copied from our own editor DOM
							dangerouslySetInnerHTML={{ __html: activeSnapshot.html }}
						/>
					) : null}
				</DragOverlay>
			</DndContext>

			{menu &&
				createPortal(
					<AnimatePresence>
						<BlockContextMenu
							state={menu}
							textColor={textColor}
							canDelete={blockKeys.length > 1}
							onClose={closeMenu}
							onTurnInto={handleTurnInto}
							onDuplicate={handleDuplicate}
							onDelete={handleDelete}
							onShowTurnInto={() =>
								setMenu((m) => (m ? { ...m, view: "turnInto" } : m))
							}
							onBack={() =>
								setMenu((m) => (m ? { ...m, view: "main" } : m))
							}
						/>
					</AnimatePresence>,
					document.body,
				)}
		</>
	);
}
