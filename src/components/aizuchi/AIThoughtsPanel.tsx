import { ChevronUpIcon, LightbulbIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type {
	AIThoughtRecord,
	ThoughtIntent,
} from "@/lib/aizuchi/schemas";

const INTENT_STYLE: Record<ThoughtIntent, string> = {
	unresolved:
		"border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	question: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
	pattern:
		"border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
	observation:
		"border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
	fyi: "border-zinc-500/20 bg-zinc-500/5 text-muted-foreground",
};

const INTENT_LABEL: Record<ThoughtIntent, string> = {
	unresolved: "Unresolved",
	question: "Question",
	pattern: "Pattern",
	observation: "Observation",
	fyi: "FYI",
};

function relativeTime(ms: number): string {
	const seconds = Math.floor((Date.now() - ms) / 1000);
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}

export function AIThoughtsPanel({
	thoughts,
	open,
	onToggle,
}: {
	thoughts: AIThoughtRecord[];
	open: boolean;
	onToggle: () => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const unresolvedCount = thoughts.filter(
		(t) => t.intent === "unresolved" || t.intent === "question",
	).length;
	const latest = thoughts[0];

	useEffect(() => {
		if (open && scrollRef.current) {
			scrollRef.current.scrollTop = 0;
		}
	}, [open, thoughts.length]);

	if (thoughts.length === 0) return null;

	return (
		<motion.div
			layout
			className="w-[min(380px,32vw)] overflow-hidden rounded-md bg-background/85 shadow-md backdrop-blur"
		>
			<AnimatePresence initial={false}>
				{open && (
					<motion.div
						key="thoughts-list"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
						className="overflow-hidden"
					>
						<div
							ref={scrollRef}
							className="max-h-[40vh] space-y-2 overflow-y-auto border-b border-border/40 px-3 py-3"
						>
							{thoughts.map((thought) => (
								<div
									key={thought.id}
									className={cn(
										"rounded-md border px-2.5 py-1.5 text-xs",
										INTENT_STYLE[thought.intent],
									)}
								>
									<div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">
										<span>{INTENT_LABEL[thought.intent]}</span>
										<span className="opacity-60">·</span>
										<span className="opacity-60">
											{relativeTime(thought.updatedAt)}
										</span>
									</div>
									<div className="leading-snug">{thought.text}</div>
								</div>
							))}
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/40"
			>
				<LightbulbIcon className="size-3.5 shrink-0 text-amber-500" />
				<div className="flex-1 overflow-hidden">
					<span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						AI thoughts
					</span>{" "}
					{!open && latest && (
						<span className="text-xs text-foreground">{latest.text}</span>
					)}
				</div>
				<span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
					{thoughts.length}
					{unresolvedCount > 0 && (
						<span className="ml-1 text-amber-500">
							· {unresolvedCount} open
						</span>
					)}
				</span>
				<ChevronUpIcon
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform duration-200",
						open ? "rotate-180" : "",
					)}
				/>
			</button>
		</motion.div>
	);
}
