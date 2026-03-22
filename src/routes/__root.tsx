import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";

const RootLayout = () => (
	<>
		<TooltipProvider>
			<Outlet />
		</TooltipProvider>
	</>
);

export const Route = createRootRoute({ component: RootLayout });
