import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "ok", game: "quake2", engine: "qwasm2" });
}
