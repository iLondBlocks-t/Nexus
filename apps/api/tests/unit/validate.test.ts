import { describe, expect, it } from "vitest";
import { checkBalance } from "../../src/gamebuilder/validate.js";

describe("GDScript bracket balance", () => {
  it("accepts balanced code with strings and comments containing brackets", () => {
    expect(checkBalance('var s = "(["\n# ]]]\nfunc f(a: int) -> void:\n\tprint([a, {"k": 1}])\n')).toBeUndefined();
  });
  it("reports an unclosed bracket", () => {
    expect(checkBalance("func f():\n\tprint((1)\n")).toMatch(/unclosed/);
  });
  it("reports an unterminated string", () => {
    expect(checkBalance('var s = "abc\n')).toMatch(/unterminated string/);
  });
});
