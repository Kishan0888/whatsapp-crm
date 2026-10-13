import { Suspense } from "react";
import { MessageCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

type SP = Promise<Record<string, string | undefined>>;

async function LoginNotices({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return (
    <>
      {sp.setup && (
        <p className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          Supabase is not configured. Copy <code>.env.example</code> to <code>.env.local</code> and fill in your project keys.
        </p>
      )}
      {sp.inactive && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">Your account is deactivated.</p>}
      <LoginForm next={sp.next} />
    </>
  );
}

export default function LoginPage({ searchParams }: { searchParams: SP }) {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessageCircle className="size-5" />
          </div>
          <CardTitle className="text-xl">Sign in to WhatsApp CRM</CardTitle>
          <CardDescription>Internal access only. Accounts are created by an admin.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Suspense fallback={<LoginForm />}>
            <LoginNotices searchParams={searchParams} />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
