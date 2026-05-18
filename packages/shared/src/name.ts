/** Only allow letters, numbers, hyphens, underscores, and spaces */
const SAFE_NAME = /^[a-zA-Z0-9 _-]+$/;
const MIN_LENGTH = 1;
const MAX_LENGTH = 20;

export function validateName(name: string): string | null {
  if (name.length < MIN_LENGTH) return "Name cannot be empty.";
  if (name.length > MAX_LENGTH)
    return `Name must be ${MAX_LENGTH} characters or less.`;
  if (!SAFE_NAME.test(name))
    return "Name can only contain letters, numbers, spaces, hyphens, and underscores.";
  return null;
}
