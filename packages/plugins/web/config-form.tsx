import {
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFoot,
  EmptyState,
  ErrorText,
  Field,
  ListInput,
  Row,
  Rows,
  Section,
  Select,
  Switch,
  TextInput,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useState,
} from "react";
import { type TObject, type TSchema, Type } from "typebox";
import { annotation, type PluginDefinition } from "../src/definition";

type Value = Readonly<Record<string, unknown>>;

// The plugin's config, read and saved as a whole, so a collection and the
// other fields can't overwrite each other's change.
function useStored(id: string): {
  readonly value: Value | undefined;
  readonly error: string | undefined;
  readonly save: (next: Value) => Promise<boolean>;
} {
  const [value, setValue] = useState<Value>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;

    storedConfig(id).then(
      (loaded) => {
        if (current) {
          setValue(loaded);
        }
      },
      (failed: unknown) => {
        if (current) {
          setError(messageOf(failed));
        }
      },
    );

    return () => {
      current = false;
    };
  }, [id]);

  return {
    value,
    error,
    save: async (next) => {
      const response = await fetch(`/api/plugins/${id}/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: next }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        readonly value?: Value;
        readonly message?: string;
      };

      if (!response.ok) {
        setError(body.message ?? `Saving failed: ${String(response.status)}`);

        return false;
      }

      setError(undefined);
      setValue(body.value ?? next);

      return true;
    },
  };
}

// The plugin's config schema as a form, with a list for each collection.
export function ConfigForm({
  plugin,
  path,
}: {
  readonly plugin: PluginDefinition;
  readonly path?: string;
}): ReactElement | null {
  const stored = useStored(plugin.id);
  const [draft, setDraft] = useState<Value>({});
  const schema = plugin.config;

  if (schema === undefined) {
    return null;
  }

  const shown = Object.entries(schema.properties).filter(
    ([name, field]) =>
      (path === undefined || path === name) && marks(field)["hidden"] !== true,
  );

  const plain = shown.filter(([, field]) => collectionKey(field) === undefined);

  const collections = shown.filter(
    ([, field]) => collectionKey(field) !== undefined,
  );

  if (stored.value === undefined) {
    return stored.error === undefined ? null : (
      <ErrorText>{stored.error}</ErrorText>
    );
  }

  const value = stored.value;

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    void stored.save({ ...value, ...draft }).then((saved) => {
      if (saved) {
        setDraft({});
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {plain.length > 0 && (
        <Card>
          <form onSubmit={submit} className="flex flex-col gap-4 p-4">
            {plain.map(([name, field]) => (
              <FieldInput
                key={name}
                schema={field}
                label={titleOf(field, name)}
                stored={value[name]}
                value={draft[name]}
                onChange={(next) => {
                  setDraft({ ...draft, [name]: next });
                }}
              />
            ))}
            <ErrorText>{stored.error}</ErrorText>
            <div>
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </form>
        </Card>
      )}
      {collections.map(([name]) => (
        <Collection key={name} schema={schema} name={name} stored={stored} />
      ))}
    </div>
  );
}

// The named records of one of the plugin's collections, added, changed and
// removed one at a time.
function Collection({
  schema,
  name,
  stored,
}: {
  readonly schema: TObject;
  readonly name: string;
  readonly stored: ReturnType<typeof useStored>;
}): ReactElement | null {
  const [editing, setEditing] = useState<{ readonly at: number | undefined }>();
  const [draft, setDraft] = useState<Value>({});
  const collection = schema.properties[name];
  const key = collection && collectionKey(collection);

  if (
    collection === undefined ||
    key === undefined ||
    !Type.IsArray(collection) ||
    !Type.IsObject(collection.items) ||
    stored.value === undefined
  ) {
    return null;
  }

  const item = collection.items;
  const value = stored.value;
  const items = (Array.isArray(value[name]) ? value[name] : []) as Value[];
  const title = titleOf(collection, name);
  const open = editing === undefined ? undefined : items[editing.at ?? -1];

  const itemFields = Object.entries(item.properties).filter(
    ([, part]) => marks(part)["hidden"] !== true,
  );

  const put = async (next: readonly Value[]): Promise<boolean> =>
    stored.save({ ...value, [name]: next });

  const close = (): void => {
    setEditing(undefined);
    setDraft({});
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const changed = { ...open, ...draft };

    const next =
      editing?.at === undefined
        ? [...items, changed]
        : items.map((each, at) => (at === editing.at ? changed : each));

    void put(next).then((saved) => {
      if (saved) {
        close();
      }
    });
  };

  return (
    <Section
      title={title}
      actions={
        <Button
          onClick={() => {
            setEditing({ at: undefined });
          }}
        >
          Add
        </Button>
      }
    >
      {items.length === 0 ? (
        <EmptyState>Nothing here yet. Add the first one.</EmptyState>
      ) : (
        <Rows label={title}>
          {items.map((each, at) => (
            <Row key={String(each[key])} title={String(each[key])}>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing({ at });
                }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void put(items.filter((_, other) => other !== at));
                }}
              >
                Remove
              </Button>
            </Row>
          ))}
        </Rows>
      )}
      <Dialog
        open={editing !== undefined}
        onClose={close}
        title={open === undefined ? `Add to ${title}` : String(open[key])}
      >
        <form onSubmit={submit}>
          <DialogBody className="flex flex-col gap-4">
            {itemFields.map(([field, part]) => (
              <FieldInput
                key={field}
                schema={part}
                label={titleOf(part, field)}
                stored={open?.[field]}
                value={draft[field]}
                onChange={(next) => {
                  setDraft({ ...draft, [field]: next });
                }}
              />
            ))}
            <ErrorText>{stored.error}</ErrorText>
          </DialogBody>
          <DialogFoot>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </DialogFoot>
        </form>
      </Dialog>
    </Section>
  );
}

// value is what was typed and not saved yet; stored is what pipoca.json has.
function FieldInput({
  schema,
  label,
  stored,
  value,
  onChange,
}: {
  readonly schema: TSchema;
  readonly label: string;
  readonly stored: unknown;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}): ReactElement | null {
  const shown = value ?? stored;
  const hint = textOf(schema, "description");

  const field = (control: ReactNode): ReactElement => (
    <Field label={label} {...(hint !== undefined && { hint })}>
      {control}
    </Field>
  );

  if (marks(schema)["secret"] !== undefined) {
    return field(
      <TextInput
        type="password"
        autoComplete="new-password"
        value={typeof value === "string" ? value : ""}
        placeholder={secretPlaceholder(stored)}
        onChange={(event) => {
          onChange(event.target.value === "" ? undefined : event.target.value);
        }}
      />,
    );
  }

  if (Type.IsBoolean(schema)) {
    return (
      <Switch
        label={label}
        checked={shown === true}
        onChange={(checked) => {
          onChange(checked);
        }}
      />
    );
  }

  if (Type.IsNumber(schema) || Type.IsInteger(schema)) {
    return field(
      <TextInput
        type="number"
        inputMode="numeric"
        value={typeof shown === "number" ? String(shown) : ""}
        onChange={(event) => {
          onChange(event.target.valueAsNumber);
        }}
      />,
    );
  }

  if (Type.IsUnion(schema)) {
    const options = schema.anyOf.flatMap((option) =>
      Type.IsLiteral(option) && typeof option.const === "string"
        ? [option.const]
        : [],
    );

    return field(
      <Select
        value={typeof shown === "string" ? shown : ""}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>,
    );
  }

  if (Type.IsArray(schema)) {
    return (
      <ListInput
        label={label}
        values={Array.isArray(shown) ? shown.map(String) : []}
        onChange={(values) => {
          onChange(values);
        }}
      />
    );
  }

  if (Type.IsString(schema)) {
    return field(
      <TextInput
        value={typeof shown === "string" ? shown : ""}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />,
    );
  }

  return null;
}

function secretPlaceholder(stored: unknown): string {
  if (isRecord(stored) && typeof stored["env"] === "string") {
    return `From ${stored["env"]}`;
  }

  return isRecord(stored) && typeof stored["sealed"] === "string"
    ? "Saved, type to replace"
    : "";
}

function titleOf(schema: TSchema, name: string): string {
  return textOf(schema, "title") ?? name;
}

function textOf(
  schema: TSchema,
  key: "title" | "description",
): string | undefined {
  const text: unknown = Reflect.get(schema, key);

  return typeof text === "string" ? text : undefined;
}

function marks(schema: TSchema): Value {
  const found: unknown = Reflect.get(schema, annotation);

  return isRecord(found) ? found : {};
}

function collectionKey(schema: TSchema): string | undefined {
  const collection = marks(schema)["collection"];

  return isRecord(collection) && typeof collection["key"] === "string"
    ? collection["key"]
    : undefined;
}

function isRecord(value: unknown): value is Value {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function storedConfig(
  id: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await fetch(`/api/plugins/${id}/config`);

  if (!response.ok) {
    throw new Error(`the config didn't load: ${String(response.status)}`);
  }

  const { value } = (await response.json()) as { readonly value: unknown };

  return (value ?? {}) as Readonly<Record<string, unknown>>;
}
