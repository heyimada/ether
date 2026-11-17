import { Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { api, del, patch, put, upload } from "../lib/api";
import { plural } from "../lib/format";
import { Avatar, ErrorNote, Field, onSubmit, ROW, Status, useAction } from "./ui";
import { GIF_AVATAR_MAX_MB, MAX_GIF_AVATAR, MAX_PINS, MAX_SOCIALS, PROFILE_FIELDS } from "../../shared/profiles";

export type MyProfile = {
  profile: {
    displayName: string;
    bio: string;
    pronouns: string;
    company: string;
    location: string;
    website: string;
    socials: string[];
    status: string;
    avatarVersion: number | null;
  };
  emails: string[];
  pushEmails: { email: string; commits: number; yours: boolean }[];
  pins: string[];
};

export const loadMyProfile = () => api<MyProfile>("/api/me/profile");

const FORM_GRID = "grid grid-cols-2 gap-x-4 max-sm:grid-cols-1";

// Stills are resized to a 256px square and re-encoded, which also drops EXIF data such as GPS
// position. GIFs go up untouched (they carry no EXIF) so animation survives; CSS crops them.
async function avatarBody(file: File): Promise<Blob> {
  if (file.type === "image/gif") {
    if (file.size > MAX_GIF_AVATAR) throw new Error(`GIF avatars can be at most ${GIF_AVATAR_MAX_MB} MB`);
    return file;
  }
  return toAvatarPng(file);
}

async function toAvatarPng(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read that image"))), "image/png"));
}

export function ProfileSettings({ me, data, repos }: { me: string; data: MyProfile; repos: string[] }) {
  const router = useRouter();
  const p = data.profile;
  const [form, setForm] = useState({ ...p, socials: Array.from({ length: MAX_SOCIALS }, (_, i) => p.socials[i] ?? "") });
  const [status, setStatus] = useState("");
  const [avatarStatus, setAvatarStatus] = useState("");
  const [emails, setEmails] = useState(data.emails.join("\n"));
  const [emailStatus, setEmailStatus] = useState("");
  const [pins, setPins] = useState<string[]>(data.pins);
  const [pinStatus, setPinStatus] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [key]: e.target.value });
    setStatus("");
  };
  const saveProfile = useAction(async () => {
    const { avatarVersion: _, ...fields } = form;
    await patch("/api/me/profile", { ...fields, socials: form.socials.filter(Boolean) });
    setStatus("Profile saved");
    await router.invalidate();
  });
  const uploadAvatar = useAction(async (file: File) => {
    setAvatarStatus("");
    const body = await avatarBody(file);
    await upload("/api/me/avatar", body);
    setAvatarStatus("Avatar updated");
    await router.invalidate();
  });
  const removeAvatar = useAction(async () => {
    await del("/api/me/avatar");
    setAvatarStatus("Avatar removed");
    await router.invalidate();
  });
  const saveEmails = useAction(async () => {
    setEmailStatus("");
    await put("/api/me/emails", { emails: emails.split(/[\s,]+/).filter(Boolean) });
    setEmailStatus("Commit emails saved");
    await router.invalidate();
  });
  const savePins = useAction(async () => {
    setPinStatus("");
    await put("/api/me/pins", { repos: pins });
    setPinStatus("Pins saved");
    await router.invalidate();
  });

  return (
    <>
      <section className="card">
        <header>
          <h2 className="m-0">Public profile</h2>
          <span className="flex-1" />
          <Link to="/$owner" params={{ owner: me }}>
            View profile
          </Link>
        </header>
        <div className="body stack-md">
          <div className="flex flex-wrap items-start gap-4">
            <Avatar name={me} size={96} />
            <div className="stack-sm">
              <ErrorNote error={uploadAvatar.error ?? removeAvatar.error} />
              <label htmlFor="avatar-file" className="button m-0 self-start">
                Upload avatar
              </label>
              <input
                id="avatar-file"
                ref={fileRef}
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadAvatar.run(file);
                  e.target.value = "";
                }}
              />
              <span className="hint m-0">
                PNG, JPEG, GIF or WebP. Animated GIFs stay animated (up to {GIF_AVATAR_MAX_MB} MB). Images are cropped to a square.
              </span>
              <div className={ROW}>
                {p.avatarVersion && (
                  <button type="button" className="small" onClick={() => removeAvatar.run()} disabled={removeAvatar.pending}>
                    Remove avatar
                  </button>
                )}
                <Status text={avatarStatus} />
              </div>
            </div>
          </div>
          <form className="stack-md" onSubmit={onSubmit(saveProfile.run)}>
            <ErrorNote error={saveProfile.error} />
            <div className={FORM_GRID}>
              <Field id="p-name" label="Display name">
                <input id="p-name" value={form.displayName} onChange={set("displayName")} maxLength={PROFILE_FIELDS.displayName} autoComplete="name" />
              </Field>
              <Field id="p-pronouns" label="Pronouns">
                <input id="p-pronouns" value={form.pronouns} onChange={set("pronouns")} maxLength={PROFILE_FIELDS.pronouns} />
              </Field>
            </div>
            <Field id="p-bio" label="Bio" hint={`Plain text, up to ${PROFILE_FIELDS.bio} characters.`}>
              <textarea className="min-h-[72px]" id="p-bio" value={form.bio} onChange={set("bio")} maxLength={PROFILE_FIELDS.bio} />
            </Field>
            <Field id="p-status" label="Status" hint="A short note shown on your profile, like what you are working on.">
              <input id="p-status" value={form.status} onChange={set("status")} maxLength={PROFILE_FIELDS.status} />
            </Field>
            <div className={FORM_GRID}>
              <Field id="p-company" label="Company">
                <input id="p-company" value={form.company} onChange={set("company")} maxLength={PROFILE_FIELDS.company} autoComplete="organization" />
              </Field>
              <Field id="p-location" label="Location">
                <input id="p-location" value={form.location} onChange={set("location")} maxLength={PROFILE_FIELDS.location} />
              </Field>
            </div>
            <Field id="p-website" label="Website">
              <input id="p-website" type="url" value={form.website} onChange={set("website")} placeholder="https://" />
            </Field>
            <fieldset className="stack-sm fieldset">
              <legend>Social links</legend>
              {form.socials.map((value, i) => (
                <input
                  key={i}
                  type="url"
                  aria-label={`Social link ${i + 1}`}
                  placeholder="https://"
                  value={value}
                  onChange={(e) => {
                    const socials = [...form.socials];
                    socials[i] = e.target.value;
                    setForm({ ...form, socials });
                    setStatus("");
                  }}
                />
              ))}
            </fieldset>
            <div className={ROW}>
              <button className="primary" disabled={saveProfile.pending}>
                Save profile
              </button>
              <Status text={status} />
            </div>
          </form>
        </div>
      </section>

      <section className="card">
        <header>
          <h2 className="m-0">Contributions</h2>
        </header>
        <form className="body stack-sm" onSubmit={onSubmit(saveEmails.run)}>
          <ErrorNote error={saveEmails.error} />
          <Field id="emails" label="Commit emails" hint="One per line. Commits authored with these addresses count towards your contribution graph. An address can belong to one account only.">
            <textarea id="emails" value={emails} onChange={(e) => setEmails(e.target.value)} className="font-mono min-h-[72px]" />
          </Field>
          {data.pushEmails.some((p) => !p.yours) && (
            <div className="stack-sm gap-1.5">
              <span className="hint m-0">
                Found in commits you pushed. Add the ones that are yours.
              </span>
              <ul className="list card" aria-label="Emails in your pushes">
                {data.pushEmails
                  .filter((p) => !p.yours)
                  .map((p) => {
                    const listed = emails.split(/[\s,]+/).includes(p.email);
                    return (
                      <li className="py-2 px-3" key={p.email}>
                        <span className="font-mono wrap-anywhere min-w-0">
                          {p.email}
                        </span>
                        <span className="text-muted tabular-nums">
                          {plural(p.commits, "commit")}
                        </span>
                        <span className="flex-1" />
                        <button
                          type="button"
                          className="small"
                          disabled={listed}
                          onClick={() => {
                            setEmails([...emails.split(/[\s,]+/).filter(Boolean), p.email].join("\n"));
                            setEmailStatus("");
                          }}
                        >
                          {listed ? "Added" : "Add"}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </div>
          )}
          <div className={ROW}>
            <button disabled={saveEmails.pending}>Save commit emails</button>
            <Status text={emailStatus} />
          </div>
        </form>
      </section>

      <section className="card">
        <header>
          <h2 className="m-0">Pinned repositories</h2>
          <span className="text-muted tabular-nums">{pins.length} / {MAX_PINS}</span>
        </header>
        <form className="body stack-sm" onSubmit={onSubmit(savePins.run)}>
          <ErrorNote error={savePins.error} />
          {repos.length === 0 ? (
            <p className="text-muted m-0">
              No repositories to pin yet.
            </p>
          ) : (
            <fieldset className="fieldset flex flex-col gap-2">
              <legend className="sr-only">Repositories to pin</legend>
              {repos.map((full) => {
                const checked = pins.includes(full);
                return (
                  <label key={full} className="radio">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && pins.length >= MAX_PINS}
                      onChange={() => {
                        setPins(checked ? pins.filter((x) => x !== full) : [...pins, full]);
                        setPinStatus("");
                      }}
                    />
                    <span className="font-mono">{full}</span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <div className={ROW}>
            <button disabled={savePins.pending}>Save pins</button>
            <Status text={pinStatus} />
          </div>
        </form>
      </section>
    </>
  );
}
