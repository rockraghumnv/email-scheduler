import axios from "axios";

interface ApiErrorBody {
  error?: string;
  details?: {
    fieldErrors?: Record<string, string[]>;
    formErrors?: string[];
  };
}

// Centralizes turning a failed request into UI-safe copy: never surfaces
// error.message/stack (which can include internals), only the backend's
// sanitized `error` field, its first Zod field-level message, or a generic
// fallback keyed off the HTTP status.
export function getErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError<ApiErrorBody>(error)) {
    return fallback;
  }

  if (!error.response) {
    return "Connection error. Check your network and try again.";
  }

  const { status, data } = error.response;

  const fieldError = data?.details?.fieldErrors && Object.values(data.details.fieldErrors).flat()[0];
  if (fieldError) {
    return fieldError;
  }
  if (data?.error) {
    return data.error;
  }
  if (status === 401) {
    return "Please log in to continue.";
  }
  if (status === 403) {
    return "You don't have permission to do that.";
  }
  if (status === 400 || status === 422) {
    return "That request wasn't valid. Please check the details and try again.";
  }
  if (status >= 500) {
    return "Something went wrong on our end. Please try again.";
  }
  return fallback;
}
