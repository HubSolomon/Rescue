import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { de } from "../i18n/messages.de";
import {
  DefinitionList,
  EmptyState,
  ErrorState,
  Money,
  Skeleton,
  StatusBadge,
  errorMessage
} from "../components/ui";

describe("state components announce themselves to assistive technology", () => {
  it("an empty state is a status, not silent decoration", () => {
    render(<EmptyState title="Noch keine Anfragen" body="Sobald Sie eine anfragen." />);
    const status = screen.getByRole("status");
    expect(within(status).getByText("Noch keine Anfragen")).toBeInTheDocument();
  });

  it("an error state is an alert, so it interrupts", () => {
    render(<ErrorState title="Fehler" body="Bitte erneut versuchen." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Fehler");
  });

  it("a skeleton reports busy and carries a text label", () => {
    render(<Skeleton rows={2} label="Wird geladen …" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Wird geladen …");
  });
});

describe("status badges", () => {
  it("carry their meaning as text, not colour alone", () => {
    render(<StatusBadge status="COMPLETED" messages={de} />);
    // WCAG 1.4.1: the tone class is decoration; the word is the information.
    expect(screen.getByText(de.job.status.COMPLETED)).toBeInTheDocument();
  });

  it("render every status the API can return", () => {
    for (const status of [
      "DRAFT",
      "TRIAGED",
      "QUOTED",
      "ASSIGNED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED"
    ] as const) {
      const { unmount } = render(<StatusBadge status={status} messages={de} />);
      expect(screen.getByText(de.job.status[status])).toBeInTheDocument();
      unmount();
    }
  });
});

describe("money rendering", () => {
  it("formats integer cents as euros", () => {
    render(<Money cents={29_750} locale="de" />);
    expect(screen.getByText(/297,50/)).toBeInTheDocument();
  });

  it("does not round a cent away", () => {
    render(<Money cents={1} locale="de" />);
    expect(screen.getByText(/0,01/)).toBeInTheDocument();
  });
});

describe("definition lists are real dl markup", () => {
  it("pairs each term with its value", () => {
    render(<DefinitionList items={[{ term: "Abholung", value: "Am Markt 1" }]} />);
    expect(screen.getByText("Abholung").tagName).toBe("DT");
    expect(screen.getByText("Am Markt 1").tagName).toBe("DD");
  });
});

describe("error code mapping", () => {
  it("translates a known code", () => {
    expect(errorMessage("OFFER_ALREADY_TAKEN", de)).toBe(de.errors.OFFER_ALREADY_TAKEN);
  });

  it("falls back rather than showing a raw code to the user", () => {
    expect(errorMessage("SOMETHING_NEW", de)).toBe(de.errors.UNKNOWN);
    expect(errorMessage(undefined, de)).toBe(de.errors.UNKNOWN);
  });
});
