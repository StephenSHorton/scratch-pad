import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useCloseWindowHotkey } from "@/hooks/useCloseWindowHotkey";

function Root() {
	useCloseWindowHotkey();
	return <Outlet />;
}

export const Route = createRootRoute({ component: Root });
