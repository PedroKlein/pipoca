import { Button, Icon, TextInput } from "@pipoca/ui";
import { type ReactElement, useState } from "react";

export function AddPage({
  onAdd,
}: {
  readonly onAdd: (title: string) => void;
}): ReactElement {
  const [title, setTitle] = useState<string>();

  if (title === undefined) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 justify-start"
        onClick={() => {
          setTitle("");
        }}
      >
        <Icon name="plus" />
        Add page
      </Button>
    );
  }

  return (
    <form
      className="mt-1 px-1"
      onSubmit={(event) => {
        event.preventDefault();

        if (title.trim() !== "") {
          onAdd(title.trim());
        }

        setTitle(undefined);
      }}
    >
      <TextInput
        aria-label="New page title"
        placeholder="Page title"
        autoFocus
        maxLength={60}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setTitle(undefined);
          }
        }}
      />
    </form>
  );
}
