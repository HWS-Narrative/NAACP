import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHash } from "node:crypto";


type VolunteerRecord = {
  full_name: string;
  email: string;
  phone: string | null;
  city_county: string | null;
  interests: string[];
  interest_other_text: string | null;
  experience: string | null;
  time_available: string | null;
  volunteer_format: string | null;
  motivation: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}


function slugify(s: string) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function q5InterestToTag(label: string) {
  const key = slugify(label);

  const map: Record<string, string> = {
    "social-media": "interest-social-media",
    "graphic-design": "interest-graphic-design",
    "writing-content-creation": "interest-writing-content",
    "photography-video": "interest-photography-video",
    "email-or-text-campaigns": "interest-email-text-campaigns",
    "event-promotion": "interest-event-promotion",
    "media-press-support": "interest-media-press",
    "general-communications-support": "interest-general-communications",
    "other": "interest-other",
  };

  return map[key] || `interest-${key}`;
}

async function mailchimpFetch(path: string, init: RequestInit) {
  const dc = Deno.env.get("MAILCHIMP_DC");
  const apiKey = Deno.env.get("MAILCHIMP_API_KEY");

  if (!dc || !apiKey) {
    throw new Error("Missing MAILCHIMP_DC or MAILCHIMP_API_KEY");
  }

  const url = `https://${dc}.api.mailchimp.com/3.0${path}`;

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Basic ${btoa(`anystring:${apiKey}`)}`);
  headers.set("Content-Type", "application/json");

  const res = await fetch(url, { ...init, headers });

  const text = await res.text();
  let parsed: any = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    throw new Error(
      `Mailchimp ${res.status}: ${
        typeof parsed === "string"
          ? parsed
          : JSON.stringify(parsed)
      }`
    );
  }

  return parsed;
}

function buildVolunteerTags(record: VolunteerRecord): string[] {
  const tags: string[] = [];

  tags.push("role-volunteer");

  if (record.city_county?.trim()) {
    tags.push(`county-${slugify(record.city_county)}`);
  }

  for (const interest of record.interests || []) {
    tags.push(q5InterestToTag(interest));
  }

  if (record.experience?.trim()) {
    tags.push(`experience-${slugify(record.experience)}`);
  }

  if (record.time_available?.trim()) {
    tags.push(`availability-${slugify(record.time_available)}`);
  }

  if (record.volunteer_format?.trim()) {
    tags.push(`format-${slugify(record.volunteer_format)}`);
  }

  return [...new Set(tags)];
}

function isVolunteerTag(name: string): boolean {
  return (
    name === "role-volunteer" ||
    name.startsWith("interest-") ||
    name.startsWith("experience-") ||
    name.startsWith("availability-") ||
    name.startsWith("format-") ||
    name.startsWith("county-")
  );
}

serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const expected = Deno.env.get("SUPABASE_WEBHOOK_SECRET") || "";
  const provided = req.headers.get("x-webhook-secret") || "";

  if (expected && provided !== expected) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const record: VolunteerRecord = body.record || body.new || body;
  if (!record?.email) {
    return json({ error: "Missing email" }, 400);
  }

  const email = record.email.trim().toLowerCase();
  //const subscriberHash = await md5Hex(email);
  const subscriberHash =  md5Hex(email);

  const listId = Deno.env.get("MAILCHIMP_AUDIENCE_ID");
  if (!listId) {
    return json({ error: "Missing MAILCHIMP_AUDIENCE_ID" }, 500);
  }

    const timeMap: Record<string, string> = {
    "1-2_hours": "1–2 hours per week",
    "3-5_hours": "3–5 hours per week",
    "project_based": "Project-based",
    };

    const mappedTime =
    (record.time_available && timeMap[record.time_available]) ||
    record.time_available ||
    "";

  // 1️⃣ Upsert member (overwrite merge fields)
  await mailchimpFetch(`/lists/${listId}/members/${subscriberHash}`, {
    method: "PUT",
    body: JSON.stringify({
      email_address: email,
      status_if_new: "subscribed",
      status: "subscribed",
      merge_fields: {
        FULLNAME: record.full_name ?? "",
        PHONE: record.phone ?? "",
        COUNTY: record.city_county ?? "",
        EXPERIENCE: record.experience ?? "",
        TIMEAVL: mappedTime,
        //TIMEAVL: record.time_available ?? "",
        VOLFORMAT: record.volunteer_format ?? "",
        MOTIVATION: record.motivation ?? "",
        INTOTHER: record.interest_other_text ?? "",
      },
    }),
  });

  // 2️⃣ Fetch current tags
  const current = await mailchimpFetch(
    `/lists/${listId}/members/${subscriberHash}/tags`,
    { method: "GET" }
  );

  const currentTags = current.tags || [];

  const deactivate = currentTags
    .map((t: any) => t.name)
    .filter(isVolunteerTag)
    .map((name: string) => ({
      name,
      status: "inactive",
    }));

  const newest = buildVolunteerTags(record).map((name) => ({
    name,
    status: "active",
  }));

  await mailchimpFetch(
    `/lists/${listId}/members/${subscriberHash}/tags`,
    {
      method: "POST",
      body: JSON.stringify({
        tags: [...deactivate, ...newest],
      }),
    }
  );

  return json({ ok: true });
});
