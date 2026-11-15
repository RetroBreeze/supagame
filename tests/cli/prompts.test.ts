import { expect, it } from "vitest";
import { Cancelled, Prompts } from "../../packages/cli/src/lib/prompts.ts";

function input(answers: (string | null)[]) {
  const errors: string[] = [];
  return {
    prompts: new Prompts(
      async () => answers.shift() ?? null,
      (s) => errors.push(s),
    ),
    errors,
  };
}
it("validates text and safe decimal integers without accepting rounded or exponential input", async () => {
  const { prompts, errors } = input([
    "",
    "Arcade",
    "9007199254740992",
    "1e3",
    "12",
  ]);
  expect(
    await prompts.text("Name", {
      validate: (v) => v ? undefined : "Name required",
    }),
  ).toBe("Arcade");
  expect(await prompts.integer("Maximum")).toBe("12");
  expect(errors).toHaveLength(3);
});
it("supports defaults, named and numbered single and multiple selections", async () => {
  const { prompts, errors } = input(["", "9", "2", "1,2,1", "n"]);
  expect(await prompts.text("Name", { default: "Arcade" })).toBe("Arcade");
  const choices = [{ value: "points", label: "Points" }, {
    value: "time",
    label: "Time",
  }];
  expect(await prompts.select("Type", choices)).toBe("time");
  expect(await prompts.multiselect("Modules", choices)).toEqual([
    "points",
    "time",
  ]);
  expect(await prompts.confirm("Apply?", true)).toBe(false);
  expect(errors.join()).toMatch(/choice/i);
});
it("never silently accepts invalid confirmations and treats EOF as cancellation", async () => {
  const { prompts, errors } = input(["maybe", null]);
  await expect(prompts.confirm("Apply?")).rejects.toBeInstanceOf(Cancelled);
  expect(errors).toHaveLength(1);
});
it("allows deliberately unbounded scores and rejects inverted bounds", async () => {
  const { prompts, errors } = input(["none", "-1", "10"]);
  expect(await prompts.integer("Minimum", { optional: true })).toBeUndefined();
  expect(await prompts.integer("Maximum", { min: 0 })).toBe("10");
  expect(errors).toHaveLength(1);
});
