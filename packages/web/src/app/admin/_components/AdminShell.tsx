"use client";

import { LogOut, RefreshCw } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AdminDataProvider, useAdminData } from "./admin-data";
import { activeNavItem, NAV } from "./nav";

export function AdminShell({
  local,
  email,
  children,
}: {
  local: boolean;
  /** The signed-in admin, or null when only the local secret gets you in. */
  email: string | null | undefined;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = activeNavItem(pathname);

  return (
    <AdminDataProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <Link href="/admin">
                    <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-semibold">
                      H
                    </div>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate font-semibold">Herzies</span>
                      <span className="truncate text-xs text-muted-foreground">
                        Control panel{local ? " (local)" : ""}
                      </span>
                    </div>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            {NAV.filter((g) => local || !g.localOnly).map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={active?.href === item.href}
                          tooltip={item.title}
                        >
                          <Link href={item.href}>
                            <item.icon />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                {email ? (
                  <form action="/auth/logout" method="post">
                    <SidebarMenuButton type="submit" tooltip="Sign out">
                      <LogOut />
                      <span className="truncate">{email}</span>
                    </SidebarMenuButton>
                  </form>
                ) : (
                  <SecretStatus />
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <h1 className="text-sm font-medium">
              {active?.title ?? "Control panel"}
            </h1>
            <div className="ml-auto">
              <RefreshButton />
            </div>
          </header>
          <div className="flex-1 p-4 md:p-6">
            <SecretGate>{children}</SecretGate>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </AdminDataProvider>
  );
}

function RefreshButton() {
  const { load, loading } = useAdminData();
  return (
    <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
      <RefreshCw className={loading ? "animate-spin" : undefined} />
      Refresh
    </Button>
  );
}

/** Footer entry when the local secret is what lets you in. */
function SecretStatus() {
  const { secret, setSecret } = useAdminData();
  if (!secret) return null;
  return (
    <SidebarMenuButton onClick={() => setSecret("")} tooltip="Forget secret">
      <LogOut />
      <span>Forget secret</span>
    </SidebarMenuButton>
  );
}

/**
 * Not signed in as an admin (local only): ask for GAME_ADMIN_SECRET, as
 * the old /dev/admin did, before showing a section.
 */
function SecretGate({ children }: { children: React.ReactNode }) {
  const { ready, needsSecret, setSecret } = useAdminData();
  const [value, setValue] = useState("");
  // Sections fetch on mount: hold them until the stored secret is known.
  if (!ready) return null;
  if (!needsSecret) return children;
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          <Link href="/login?next=/admin" className="underline">
            Sign in with an admin account
          </Link>{" "}
          or enter the game admin secret.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSecret(value.trim());
          }}
        >
          <Label htmlFor="admin-secret">Admin secret</Label>
          <Input
            id="admin-secret"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="GAME_ADMIN_SECRET"
          />
          <Button type="submit" disabled={!value.trim()}>
            Connect
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
