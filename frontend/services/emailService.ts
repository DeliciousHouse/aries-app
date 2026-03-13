export async function sendOTPEmail(email: string, code: string, type: 'signup' | 'reset'): Promise<{ success: boolean; error?: string }> {
  console.log(`Sending ${type} OTP email to ${email}: ${code}`);
  return { success: true };
}
