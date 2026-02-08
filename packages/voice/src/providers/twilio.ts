/**
 * Twilio voice provider for initiating and managing phone calls.
 */

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface VoiceCallResult {
  callSid: string;
  status: string;
}

export class TwilioProvider {
  private config: TwilioConfig;

  constructor(config: TwilioConfig) {
    this.config = config;
  }

  async initiateCall(input: { to: string; webhookUrl: string }): Promise<VoiceCallResult> {
    const authHeader = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString("base64");

    const body = new URLSearchParams({
      To: input.to,
      From: this.config.fromNumber,
      Url: input.webhookUrl,
    });

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    );

    if (!res.ok) {
      throw new Error(`Twilio API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { sid: string; status: string };
    return { callSid: data.sid, status: data.status };
  }

  async hangupCall(callSid: string): Promise<void> {
    const authHeader = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString("base64");

    const body = new URLSearchParams({ Status: "completed" });

    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    );
  }

  generateTwiml(streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
  }

  getConfig(): TwilioConfig {
    return this.config;
  }
}
