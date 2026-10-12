import { servePalette } from "@/lib/theme-palette";

export const dynamic = "force-dynamic";

export const GET = (request: Request) => servePalette("light", request);
