import { describe, expect, it, vi } from "vitest";
import { createFeatureGuard } from "./feature-guard";

class FakeNotFound extends Error {}

function setup(enabled: string[]) {
  const guard = createFeatureGuard({
    isEnabled: async (key) => enabled.includes(key),
    notFound: () => {
      throw new FakeNotFound("404");
    },
  });
  return guard;
}

describe("feature guard", () => {
  it("flag stins: requireFeature dă 404", async () => {
    await expect(setup([]).requireFeature("blog")).rejects.toBeInstanceOf(FakeNotFound);
  });

  it("flag pornit: requireFeature trece", async () => {
    await expect(setup(["blog"]).requireFeature("blog")).resolves.toBeUndefined();
  });

  it("flag stins: loaderul (importul codului funcției) NU se apelează", async () => {
    const loader = vi.fn(async () => ({ Blog: "cod-blog" }));
    await expect(setup([]).loadFeature("blog", loader)).rejects.toBeInstanceOf(FakeNotFound);
    expect(loader).not.toHaveBeenCalled();
  });

  it("flag pornit: loaderul se apelează și rezultatul se întoarce", async () => {
    const loader = vi.fn(async () => ({ Blog: "cod-blog" }));
    await expect(setup(["blog"]).loadFeature("blog", loader)).resolves.toEqual({
      Blog: "cod-blog",
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("un flag pornit nu deschide alt flag", async () => {
    await expect(setup(["blog"]).requireFeature("vouchers")).rejects.toBeInstanceOf(FakeNotFound);
  });
});
