import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HERO_MAX_BYTES,
  heroPhotoDirs,
  pickHeroPhoto,
} from "../../apps/web/src/app/galerie-vitrina/demo-media.e2e";

/**
 * Fotografia de hero a galeriei de design vine dintr-un folder local, necomis (`local-data/foto-hero/`). Aici se verifică doar
 * regulile de alegere, pe un folder temporar: folder lipsă sau gol → `null` (galeria folosește substituentul plat).
 */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ecom-foto-hero-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pickHeroPhoto", () => {
  it("folderul lipsă sau gol: null", async () => {
    expect(await pickHeroPhoto(join(dir, "nu-exista"))).toBeNull();
    expect(await pickHeroPhoto(dir)).toBeNull();
  });

  it("ignoră ce nu e imagine acceptată și alege prima (în ordinea numelor), ca data URI cu tipul corect", async () => {
    await writeFile(join(dir, "00-note.txt"), "nu e imagine");
    await writeFile(join(dir, "02-b.PNG"), Buffer.from([1, 2, 3]));
    await writeFile(join(dir, "01-a.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const photo = await pickHeroPhoto(dir);
    expect(photo?.src).toBe(
      `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString("base64")}`,
    );
    expect(photo?.width).toBeGreaterThan(0);
    expect(photo?.height).toBeGreaterThan(0);
  });

  it("sare peste fișierele goale și peste cele mai mari decât plafonul", async () => {
    const sub = join(dir, "plafon");
    await mkdir(sub);
    await writeFile(join(sub, "00-gol.jpg"), Buffer.alloc(0));
    await writeFile(join(sub, "01-mare.jpg"), Buffer.alloc(HERO_MAX_BYTES + 1));
    await writeFile(join(sub, "02-ok.webp"), Buffer.from([9]));
    expect((await pickHeroPhoto(sub))?.src.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("caută folderul și din apps/web, și din rădăcina depozitului", () => {
    const dirs = heroPhotoDirs(join(tmpdir(), "repo", "apps", "web")).map((d) =>
      d.replaceAll("\\", "/"),
    );
    expect(dirs[0]?.endsWith("/repo/apps/web/local-data/foto-hero")).toBe(true);
    expect(dirs[1]?.endsWith("/repo/local-data/foto-hero")).toBe(true);
  });
});
