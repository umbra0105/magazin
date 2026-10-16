import { describe, expect, it } from "vitest";
import { describeFiles, formatFileSize } from "./file-size";

const texts = {
  empty: "Niciun fișier ales",
  many: (count: number, total: string) => `${count} fișiere alese (${total})`,
};

describe("formatFileSize", () => {
  it("octeți, KB, MB și GB, cu virgulă zecimală", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(812)).toBe("812 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1229)).toBe("1,2 KB");
    expect(formatFileSize(4.2 * 1024 * 1024)).toBe("4,2 MB");
    expect(formatFileSize(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });

  it("valori nevalide nu produc text", () => {
    expect(formatFileSize(-1)).toBe("");
    expect(formatFileSize(Number.NaN)).toBe("");
  });
});

describe("describeFiles", () => {
  it("nimic ales, un fișier (nume și mărime) sau mai multe (număr și total)", () => {
    expect(describeFiles([], texts)).toBe("Niciun fișier ales");
    expect(describeFiles([{ name: "raport.csv", size: 1229 }], texts)).toBe("raport.csv (1,2 KB)");
    expect(
      describeFiles(
        [
          { name: "a.png", size: 1024 * 1024 },
          { name: "b.png", size: 3 * 1024 * 1024 },
        ],
        texts,
      ),
    ).toBe("2 fișiere alese (4 MB)");
  });
});
