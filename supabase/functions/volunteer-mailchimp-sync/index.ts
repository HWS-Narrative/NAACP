//see chatgpt Edge Function Debugging and Webhook integration (Deno deprecation in vs code 2/19/2026)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHash } from "node:crypto";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"; //added for committee 2/26/2024


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
    name.startsWith("county-") ||
    name.startsWith("committee-") //added for committee 2/26/2026
  );
}


serve(async (req) => {

//added 2/26/2026 for committee (lines 143-146)
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);


  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const expected = (Deno.env.get("WEBHOOK_SECRET") ?? "").trim();
  const got = (req.headers.get("x-webhook-secret") ?? "").trim();

  if (!expected || got !== expected) {
  return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const record: VolunteerRecord = body.record || body.new || body;
//added 2/26/2026 for committee (lines 164-187)
// 🔹 Fetch committee selections from join table
const submissionId = body.record?.id || body.new?.id;

let committeeTags: string[] = [];

if (submissionId) {
  const { data: committeeRows, error: committeeError } =
    await supabase
      .from("volunteer_submission_committees")
      .select(`
        committee:committees (
          slug,
          name
        )
      `)
      .eq("submission_id", submissionId);

  if (!committeeError && committeeRows) {
    committeeTags = committeeRows.map((row: any) =>
      `committee-${slugify(row.committee.slug)}`
    );
  }
}


  if (!record?.email) {
    return json({ error: "Missing email" }, 400);
  }

  const email = record.email.trim().toLowerCase();
  
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

    const experienceMap: Record<string, string> = {
      yes: "Yes",
      some: "Some",
      no: "No",
    };

    const mappedExperience =
      (record.experience &&
        experienceMap[String(record.experience).toLowerCase()]) ||
      "";

    const formatMap: Record<string, string> = {
      remote: "Remote",
      in_person: "In-person",
      hybrid: "Hybrid",
    };

    const mappedFormat =
      (record.volunteer_format &&
        formatMap[String(record.volunteer_format).toLowerCase()]) ||
      "";

  // 1️⃣ Upsert member (overwrite merge fields)
  await mailchimpFetch(`/lists/${listId}/members/${subscriberHash}`, {
    method: "PUT",
    body: JSON.stringify({
      email_address: email,
      status_if_new: "subscribed",
      merge_fields: {
        FULLNAME: record.full_name ?? "",
        PHONE: record.phone ?? "",
        COUNTY: record.city_county ?? "",
        EXPERIENCE: mappedExperience,
        TIMEAVL: mappedTime,
        VOLFORMAT: mappedFormat,
        MOTIVATION: record.motivation ?? "",
        INTOTHER: "", 
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

  // Build base volunteer tags (role, county, interest, etc.)
const baseTags: string[] = buildVolunteerTags(record);

// Combine base volunteer tags with committee tags
const combinedTags: string[] = [
  ...baseTags,
  ...committeeTags,
];

// Convert all tags into Mailchimp activation format
const newest = combinedTags.map((tagName: string) => ({
  name: tagName,
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
