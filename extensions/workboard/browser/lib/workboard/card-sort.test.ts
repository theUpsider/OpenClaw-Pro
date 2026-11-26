import { describe, expect, it } from "vitest";
import { sortWorkboardCards } from "./card-sort.ts";
import { createWorkboardCard } from "./test/index-helpers.ts";

const cards = [
  createWorkboardCard({ id: "first", position: 1000, createdAt: 10, updatedAt: 50 }),
  createWorkboardCard({ id: "second", position: 2000, createdAt: 30, updatedAt: 20 }),
  createWorkboardCard({ id: "third", position: 3000, createdAt: 20, updatedAt: 50 }),
];
const ids = (sorted: readonly { id: string }[]) => sorted.map((card) => card.id);

describe("sortWorkboardCards", () => {
  it("keeps the server order for position", () => {
    expect(ids(sortWorkboardCards(cards, "position"))).toEqual(["first", "second", "third"]);
  });

  it("puts the newest created card first", () => {
    expect(ids(sortWorkboardCards(cards, "created"))).toEqual(["second", "third", "first"]);
  });

  it("puts the most recently changed card first and keeps server order on ties", () => {
    expect(ids(sortWorkboardCards(cards, "updated"))).toEqual(["first", "third", "second"]);
  });

  it("does not reorder its input", () => {
    sortWorkboardCards(cards, "created");
    expect(ids(cards)).toEqual(["first", "second", "third"]);
  });
});
