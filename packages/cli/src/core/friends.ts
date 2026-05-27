import { randomBytes } from "node:crypto";
import type { Herzie } from "@herzies/shared";
import { apiLookupHerzie } from "../storage/api.js";

/** Generate a unique friend code like HERZ-A7X3 */
export function generateFriendCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(4);
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `HERZ-${code}`;
}

/** Add a friend code to a herzie — verifies it exists online */
export async function addFriend(
  herzie: Herzie,
  code: string,
): Promise<{ success: boolean; message: string }> {
  const normalized = code.toUpperCase().trim();

  if (normalized === herzie.friendCode) {
    return { success: false, message: "You can't add yourself as a friend!" };
  }

  if (herzie.friendCodes.includes(normalized)) {
    return { success: false, message: "Already friends with this Herzie!" };
  }

  if (herzie.friendCodes.length >= 20) {
    return {
      success: false,
      message: "Maximum of 20 friendzies reached!",
    };
  }

  if (!/^HERZ-[A-Z0-9]{4}$/.test(normalized)) {
    return {
      success: false,
      message: "Invalid friend code format. Expected: HERZ-XXXX",
    };
  }

  // Verify the friend code exists online
  const profile = await apiLookupHerzie(normalized);
  if (!profile) {
    return {
      success: false,
      message: `No Herzie found with code ${normalized}. Are they registered?`,
    };
  }

  herzie.friendCodes.push(normalized);
  return {
    success: true,
    message: `Added ${profile.name} (${normalized}) as a friendzie!`,
  };
}

/** Remove a friend code */
export function removeFriend(
  herzie: Herzie,
  code: string,
): { success: boolean; message: string } {
  const normalized = code.toUpperCase().trim();
  const index = herzie.friendCodes.indexOf(normalized);

  if (index === -1) {
    return { success: false, message: "Friend code not found." };
  }

  herzie.friendCodes.splice(index, 1);
  return { success: true, message: `Removed ${normalized} from friendzies.` };
}
