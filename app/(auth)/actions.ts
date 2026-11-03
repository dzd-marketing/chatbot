"use server";

import { z } from "zod";
import { webLogin } from "@/lib/thestudent/api";
import { signIn } from "./auth";

const loginSchema = z.object({
  email: z.email().max(255),
  password: z.string().min(1).max(256),
});

export type LoginActionState = {
  status: "idle" | "success" | "failed" | "invalid_data";
  /** Shown on the form as-is (auth.php's own message on rejection). */
  message?: string;
};

export const login = async (
  _: LoginActionState,
  formData: FormData
): Promise<LoginActionState> => {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return {
      message: "Enter your TheStudent email and password.",
      status: "invalid_data",
    };
  }

  const result = await webLogin(parsed.data.email, parsed.data.password);
  if (!result.ok) {
    return { message: result.message, status: "failed" };
  }

  try {
    await signIn("thestudent", { redirect: false, token: result.token });
  } catch {
    return {
      message: "Could not start your session. Please try again.",
      status: "failed",
    };
  }
  return { status: "success" };
};
