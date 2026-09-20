import type { FastifyBaseLogger } from "fastify";
import type { NotificationChannel, NotificationKind } from "@rescue/contracts";

/**
 * Telling people things.
 *
 * A port with one development adapter. The adapter logs; it does not send,
 * and `parseConfig` refuses it in production for the same reason it refuses
 * the mock storage signer. Swapping in a real provider is one class, because
 * nothing above this interface knows how a message is delivered.
 *
 * Notifications are driven from the outbox, never from a route handler. That
 * is what makes them survive a crash between "the job moved" and "the provider
 * was told", and what stops a retried HTTP request from sending twice.
 */

export interface NotificationRecipient {
  /** Who this is, for the log and for the provider's own addressing. */
  userId: string | null;
  email: string | null;
  name: string | null;
}

export interface Notification {
  kind: NotificationKind;
  channel: NotificationChannel;
  to: NotificationRecipient;
  /** Subject line, or the first line of a push. Already localised. */
  subject: string;
  body: string;
  /** The job it concerns, so a failed send can be traced back. */
  jobId: string | null;
}

export interface NotificationSender {
  readonly kind: "log" | "smtp" | "provider";
  send(notification: Notification): Promise<{ reference: string }>;
}

/**
 * Development sender.
 *
 * Writes what would have gone out, at info level, with the recipient and the
 * subject but never the whole body at info -- a body can contain an address or
 * a contact name, and logs are the least access-controlled thing in the
 * system. The body goes to debug, where it is off by default.
 */
export class LoggingNotificationSender implements NotificationSender {
  readonly kind = "log" as const;
  private sequence = 0;

  constructor(private readonly logger: FastifyBaseLogger) {}

  async send(notification: Notification): Promise<{ reference: string }> {
    this.sequence += 1;
    const reference = `log-${this.sequence}`;
    this.logger.info(
      {
        notification: {
          kind: notification.kind,
          channel: notification.channel,
          to: notification.to.email ?? notification.to.userId ?? "unknown",
          subject: notification.subject,
          jobId: notification.jobId,
          reference
        }
      },
      "notification not sent: the development sender only logs"
    );
    this.logger.debug({ body: notification.body, reference }, "notification body");
    return { reference };
  }
}

/**
 * A sender that records instead of logging, for tests.
 *
 * Kept here rather than in the test folder because the conformance of a real
 * sender is judged against it: anything that claims to implement the port
 * should be substitutable for this in a test and change nothing.
 */
export class RecordingNotificationSender implements NotificationSender {
  readonly kind = "log" as const;
  readonly sent: Notification[] = [];
  /** Set to make the next `send` throw, to exercise the retry path. */
  failNext = 0;

  async send(notification: Notification): Promise<{ reference: string }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("notification provider unavailable");
    }
    this.sent.push(notification);
    return { reference: `recorded-${this.sent.length}` };
  }
}
