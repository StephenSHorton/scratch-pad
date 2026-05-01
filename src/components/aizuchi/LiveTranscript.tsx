import { ChevronUpIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import type {
	PassRecord,
	ThoughtIntent,
	TranscriptChunk,
} from "@/lib/aizuchi/schemas";

const INTENT_BADGE_STYLE: Record<ThoughtIntent, string> = {
	unresolved:
		"bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
	question: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40",
	pattern:
		"bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40",
	observation:
		"bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
	fyi: "bg-zinc-500/5 text-muted-foreground border-zinc-500/20",
};

function PassMarker({ pass }: { pass: PassRecord }) {
	if (pass.thoughts.length === 0) return null;
	return (
		<motion.div
			initial={{ opacity: 0, x: -8 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.2 }}
			className="my-1.5 ml-3 flex flex-col gap-1 border-l-2 border-amber-500/60 pl-3"
		>
			{pass.thoughts.map((t) => (
				<div
					key={t.id}
					className={`rounded-md border px-2 py-1 text-xs ${INTENT_BADGE_STYLE[t.intent]}`}
				>
					<span className="mr-2 text-[9px] font-semibold uppercase tracking-wider opacity-80">
						💡 {t.intent}
					</span>
					<span className="leading-snug">{t.text}</span>
				</div>
			))}
		</motion.div>
	);
}

export function LiveTranscript({
	chunks,
	passes,
	open,
	onToggle,
}: {
	chunks: TranscriptChunk[];
	passes: PassRecord[];
	open: boolean;
	onToggle: () => void;
}) {
	const last = chunks[chunks.length - 1];
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (open && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [chunks.length, passes.length, open]);

	if (!last) return null;

	// Group passes by the chunk index they fired after.
	const passesByChunk = new Map<number, PassRecord[]>();
	for (const pass of passes) {
		const list = passesByChunk.get(pass.atChunkIdx) ?? [];
		list.push(pass);
		passesByChunk.set(pass.atChunkIdx, list);
	}

	const totalThoughts = passes.reduce((sum, p) => sum + p.thoughts.length, 0);

	return (
		<motion.div
			layout
			className="w-[min(800px,80vw)] overflow-hidden rounded-md bg-background/85 shadow-md backdrop-blur"
		>
			<AnimatePresence initial={false}>
				{open && (
					<motion.div
						key="history"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
						className="overflow-hidden"
					>
						<div
							ref={scrollRef}
							className="max-h-[50vh] space-y-2 overflow-y-auto border-b border-border/40 px-4 py-3"
						>
							{chunks.map((chunk, i) => (
								<div key={`chunk-${chunk.startMs}-${i}`}>
									<div
										className={`text-sm leading-snug ${
											i === chunks.length - 1 ? "" : "text-muted-foreground"
										}`}
									>
										<span className="mr-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
											{chunk.speaker}
										</span>
										<span>{chunk.text}</span>
									</div>
									{passesByChunk.get(i)?.map((pass) => (
										<PassMarker key={pass.id} pass={pass} />
									))}
								</div>
							))}
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/40"
			>
				<div className="flex-1 overflow-hidden">
					<span className="mr-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{last.speaker}
					</span>
					<span className="text-sm text-foreground">{last.text}</span>
				</div>
				<span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
					{chunks.length}c
					{totalThoughts > 0 && (
						<span className="ml-1 text-amber-500">· {totalThoughts}💡</span>
					)}
				</span>
				<ChevronUpIcon
					className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
						open ? "rotate-180" : ""
					}`}
				/>
			</button>
		</motion.div>
	);
}
