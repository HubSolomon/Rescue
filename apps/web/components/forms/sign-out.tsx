import { signOutAction } from "../../lib/actions/session";
import type { Locale } from "../../i18n/index";

/**
 * A form rather than a link: signing out is a state change, so it must not be
 * reachable by a GET that a prefetcher or a crawler could trigger.
 */
export function SignOutButton({ label, locale }: { label: string; locale: Locale }) {
  return (
    <form action={signOutAction}>
      <input type="hidden" name="locale" value={locale} />
      <button type="submit" className="linklike">
        {label}
      </button>
    </form>
  );
}
