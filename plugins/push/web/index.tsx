import {
  ConfigForm,
  defineWeb,
  type Slots,
  useApi,
  useLoaded,
} from "@pipoca/plugins/web";
import { Button, ErrorText, Page, Row, Rows } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { push } from "../plugin";

export const web = defineWeb(push, {
  settings: { group: "you", Section },
  slots: { "activity.channel": ActivityChannel },
  // How long a question in team work waits before its starter hears of it.
  pages: [
    {
      path: "notifications",
      label: "Notifications",
      area: "setup",
      group: "rules",
      Page: () => <ConfigForm plugin={push} />,
    },
  ],
});

const supported =
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof PushManager !== "undefined";

function useSubscription() {
  return useLoaded(
    async () =>
      supported
        ? ((
            await navigator.serviceWorker.getRegistration("/")
          )?.pushManager.getSubscription() ?? null)
        : null,
    "push.subscription",
  );
}

// Mentions, review requests and replies reach a device that turned
// notifications on; every comment stays in Pipoca.
function ActivityChannel({
  topic,
}: Slots["activity.channel"]): ReactElement | null {
  const { value } = useSubscription();

  return topic === "comments" ||
    value === null ||
    value === undefined ? null : (
    <> · push</>
  );
}

function Section(): ReactElement | null {
  const api = useApi(push);
  const [error, setError] = useState<string>();

  const key = useLoaded(
    async () => (await api.get<{ key: string }>("key")).key,
    "push.key",
  ).value;

  const { value: current, reload } = useSubscription();

  if (!supported) {
    return null;
  }

  // Safari asks for permission only from a click, so the permission is asked
  // for before anything is awaited. A push subscription needs an active
  // service worker, and register resolves while the worker still installs.
  const turnOn = async (): Promise<void> => {
    if (key === undefined) {
      return;
    }

    const permission = Notification.requestPermission();

    await navigator.serviceWorker.register("/sw.js", { scope: "/" });

    if ((await permission) !== "granted") {
      throw new Error("Notifications are not allowed in this browser.");
    }

    const registration = await navigator.serviceWorker.ready;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });

    await api.put("subscriptions", subscription.toJSON());
  };

  const turnOff = async (subscription: PushSubscription): Promise<void> => {
    await api.delete("subscriptions", { endpoint: subscription.endpoint });

    await subscription.unsubscribe();
  };

  const run = (action: () => Promise<void>): void => {
    setError(undefined);

    action().then(reload, (reason: unknown) => {
      setError(failure(reason));

      reload();
    });
  };

  return (
    <Page
      title="Notifications"
      description="Where Pipoca tells you that Pi finished or needs you, even with Pipoca closed."
    >
      <Rows>
        <Row
          title="This device"
          description={
            current
              ? "Gets a notification when Pi finishes or needs you."
              : "On an iPhone, add Pipoca to the Home Screen first."
          }
        >
          {current ? (
            <Button
              onClick={() => {
                run(async () => turnOff(current));
              }}
            >
              Turn off on this device
            </Button>
          ) : (
            <Button
              disabled={key === undefined || current === undefined}
              onClick={() => {
                run(turnOn);
              }}
            >
              Turn on for this device
            </Button>
          )}
        </Row>
      </Rows>
      <ErrorText size="caption" className="mt-2">
        {error}
      </ErrorText>
    </Page>
  );
}

// Chromium browsers without Google's push service, such as Brave by default,
// fail every subscription with this AbortError.
function failure(reason: unknown): string {
  if (Notification.permission === "denied") {
    return "Notifications are blocked for Pipoca in this browser's settings.";
  }

  if (
    reason instanceof DOMException &&
    reason.name === "AbortError" &&
    reason.message.includes("push service")
  ) {
    return 'This browser could not reach its push service. In Brave, turn on "Use Google services for push messaging" in Settings > Privacy and security, restart Brave and try again. In other browsers, a network that blocks Google\'s push servers does this too.';
  }

  return String(reason);
}
