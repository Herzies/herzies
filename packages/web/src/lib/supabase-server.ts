import {
  type CookieOptions,
  createServerClient as createSSRClient,
} from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client with cookie-based sessions.
 * Use in Server Components and Route Handlers.
 */
export async function createServerClient() {
  const cookieStore = await cookies();

  return createSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: Array<{
            name: string;
            value: string;
            options: CookieOptions;
          }>,
        ) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component where cookies can't be mutated.
            // The middleware will refresh the session on the next request.
          }
        },
      },
    },
  );
}
