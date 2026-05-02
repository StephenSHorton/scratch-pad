import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

export function useCommandPaletteHotkey(): void {
	useEffect(() => {
		const label = getCurrentWindow().label;
		if (label === "palette") return;

		const handler = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				invoke("open_palette", { sourceLabel: label }).catch(() => {});
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);
}
