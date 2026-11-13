import { expect, test } from "bun:test";
import { RepoPicker, type RepoOption } from "./repo-picker";
import { byRole, click, press, render, type, withPage } from "./testing/render";

withPage();

const repository = (
  host: string,
  name: string,
  extra: Partial<RepoOption> = {},
): RepoOption => ({
  value: `https://${host}/${name}.git`,
  name,
  host,
  ...extra,
});

const first = "https://github.tools.sap/acme/terraform-0.git";

const tools = Array.from({ length: 7 }, (_, at) =>
  repository("github.tools.sap", `acme/terraform-${String(at)}`),
);

function picker(
  overrides: Partial<Parameters<typeof RepoPicker>[0]> = {},
): HTMLElement {
  return render(
    <RepoPicker
      label="Repositories"
      selected={[]}
      repositories={[
        ...tools,
        repository("github.com", "pedro/terraform-notes", {
          meta: "pushed 6mo ago",
        }),
      ]}
      recent={[
        repository("github.tools.sap", "acme/infra", {
          meta: "github.tools.sap · pushed 2h ago",
          private: true,
        }),
      ]}
      folders={{
        label: "Folders on faraday",
        options: [{ value: "/home/pedro/notes", name: "notes" }],
      }}
      placeholder="Search"
      onSearch={() => undefined}
      onChange={() => undefined}
      {...overrides}
    >
      Pick
    </RepoPicker>,
  );
}

function names(page: HTMLElement): readonly string[] {
  return [...page.querySelectorAll('[role="option"]')].map(
    (option) => option.getAttribute("aria-label") ?? "",
  );
}

test("lists the recent ones first, then each host's with a count, five at a time", () => {
  const page = picker();

  click(byRole(page, "button", "Repositories"));

  expect(names(page)).toEqual([
    "acme/infra",
    ...tools.slice(0, 5).map(({ name }) => name),
    "pedro/terraform-notes",
  ]);

  expect(page.textContent).toContain("On github.tools.sap · 7");
  expect(page.textContent).toContain("+ 2 more · keep typing to narrow");
  expect(page.textContent).toContain("Private host");
  expect(page.textContent).toContain("pushed 6mo ago");
});

test("filters by host, and lists the Environment's folders on their own", () => {
  const page = picker();

  click(byRole(page, "button", "Repositories"));

  const filters = byRole(page, "group", "Filter");

  const filter = (text: string): void => {
    click(
      [...filters.querySelectorAll("button")].find(
        (button) => button.textContent === text,
      ),
    );
  };

  filter("github.com");
  expect(names(page)).toEqual(["pedro/terraform-notes"]);

  filter("Folders on faraday");
  expect(names(page)).toEqual(["notes"]);

  filter("All hosts");
  expect(names(page)).not.toContain("notes");
});

test("a search narrows every host, matches first, and picks several, shown as chips to remove", () => {
  let picked: readonly string[] = [];
  const searched: string[] = [];

  const page = picker({
    selected: [first],
    onSearch: (query) => searched.push(query),
    onChange: (values) => {
      picked = values;
    },
  });

  click(byRole(page, "button", "Repositories"));

  const search = byRole(page, "combobox", "Repositories");
  type(search, "notes");

  expect(searched.at(-1)).toBe("notes");
  expect(names(page)).toEqual(["pedro/terraform-notes", "Use notes"]);

  press(search, "Enter");

  expect(picked).toEqual([
    first,
    "https://github.com/pedro/terraform-notes.git",
  ]);

  click(byRole(page, "button", "Remove acme/terraform-0"));

  expect(picked).toEqual([]);
});

test("offers what was typed to use as it is, even a folder listed under its own filter", () => {
  let picked: readonly string[] = [];

  const page = picker({
    onChange: (values) => {
      picked = values;
    },
  });

  click(byRole(page, "button", "Repositories"));
  type(byRole(page, "combobox", "Repositories"), "/home/pedro/notes");

  expect(byRole(page, "option", "Use /home/pedro/notes").textContent).toContain(
    "folder",
  );

  click(byRole(page, "option", "Use /home/pedro/notes"));

  expect(picked).toEqual(["/home/pedro/notes"]);
});

test("says how many were picked, each in its own worktree", () => {
  const page = picker({
    selected: tools.slice(0, 2).map(({ value }) => value),
  });

  click(byRole(page, "button", "Repositories"));

  expect(page.textContent).toContain("2 picked · each gets its own worktree");

  expect(byRole(page, "list", "Picked").textContent).toContain(
    "acme/terraform-1",
  );
});
