"use client";

import NextLink from "next/link";
import type { ComponentProps } from "react";
import { startNavigation } from "./store";

type Props = ComponentProps<typeof NextLink>;

function hrefString(href: Props["href"]): string {
  if (typeof href === "string") return href;
  return `${href.pathname ?? ""}${href.search ?? ""}${href.hash ?? ""}`;
}

/**
 * next/link that brings up the page loader when it navigates. Next calls
 * onNavigate only for in-app navigations, not for new-tab clicks
 * (cmd/ctrl/shift/middle) or `target="_blank"`, so those never show it.
 */
export default function Link({ onNavigate, ...props }: Props) {
  return (
    <NextLink
      {...props}
      onNavigate={(e) => {
        let prevented = false;
        onNavigate?.({
          preventDefault: () => {
            prevented = true;
            e.preventDefault();
          },
        });
        if (!prevented) startNavigation(hrefString(props.href));
      }}
    />
  );
}
