// Two letters for a name's mark: its first letter, then the first letter of
// its next word or capital ("GitHub" is Gh), or else its second letter.
export function initialsOf(name: string): string {
  const [first = "", ...rest] =
    name
      .match(/\p{Lu}?[\p{Ll}\p{N}]*|\p{Lu}+/gu)
      ?.filter((part) => part !== "") ?? [];

  const second = rest[0]?.[0] ?? first[1] ?? "";

  return first.slice(0, 1).toUpperCase() + second.toLowerCase();
}

// A person's mark is both initials in capitals: "Pedro Klein" is PK.
export function personInitials(name: string): string {
  return initialsOf(name).toUpperCase();
}

// "1 person", "3 Sessions": a count with its noun, plural unless it is one.
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : many}`;
}
