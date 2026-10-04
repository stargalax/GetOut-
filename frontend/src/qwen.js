import { pipeline } from "@huggingface/transformers";
import { SHAPES, matchShapeByKeyword } from "./shapes";

const MODEL_ID = "onnx-community/Qwen3-0.6B-ONNX";

let generator = null;
let loadingPromise = null;

export async function loadQwen(onProgress) {
    if (generator) return generator;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        try {
            const device = navigator.gpu ? "webgpu" : "wasm";
            console.log(`⚡ Qwen device: ${device}`);

            generator = await pipeline("text-generation", MODEL_ID, {
                device,
                dtype: "q4f16",
                progress_callback: (p) => onProgress?.(p),
            });

            console.log("✅ Qwen3 loaded locally");
            return generator;
        } catch (error) {
            generator = null;
            throw error;
        } finally {
            loadingPromise = null;
        }
    })();

    return loadingPromise;
}

function extractJSON(text) {
    if (!text) throw new Error("Qwen returned an empty response.");

    // Strip Qwen3's empty think block and markdown fences
    let cleaned = text
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/```json|```/gi, "")
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch {
        /* fall through */
    }

    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first === -1 || last === -1) {
        throw new Error(`Qwen did not return JSON: ${cleaned}`);
    }
    return JSON.parse(cleaned.slice(first, last + 1));
}

// ------------------------------------------------------------
// Distance / speed budget (all deterministic, no LLM math)
// ------------------------------------------------------------

const SPEED_KMH = {
    walking: { relaxed: 4, normal: 5, brisk: 6 },
    cycling: { relaxed: 12, normal: 15, brisk: 20 },
};

const SIZE_FACTOR = { small: 0.5, medium: 0.75, large: 1.0 };

// Roads aren't straight: routed distance is usually ~1.4x the
// straight-line perimeter of the shape.
const ROAD_FACTOR = 1.4;

// "within 2 km" / "3.5km" typed directly in the prompt
function parseDistanceKmFromPrompt(prompt) {
    const m = prompt.match(/(\d+(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?)\b/i);
    return m ? Number(m[1]) : null;
}

function parseMinutesFromPrompt(prompt) {
    const m = prompt.match(/(\d+(?:\.\d+)?)\s*(?:min|minutes?)\b/i);
    return m ? Number(m[1]) : null;
}

function computeBudget({ prompt, travelMode, maxDistanceKm, maxTimeMinutes, size, pace }) {
    const speed = (SPEED_KMH[travelMode] ?? SPEED_KMH.walking)[pace] ?? 5;

    const timeLimit = Math.min(
        maxTimeMinutes,
        parseMinutesFromPrompt(prompt) ?? Infinity
    );
    const distanceLimit = Math.min(
        maxDistanceKm,
        parseDistanceKmFromPrompt(prompt) ?? Infinity
    );

    const byTimeKm = (speed * timeLimit) / 60;
    const baseKm = Math.min(distanceLimit, byTimeKm);

    const budgetKm = baseKm * (SIZE_FACTOR[size] ?? SIZE_FACTOR.large);

    return {
        budgetKm: Math.round(budgetKm * 100) / 100,
        targetPerimeterM: Math.round((budgetKm * 1000) / ROAD_FACTOR),
        speedKmh: speed,
    };
}

// ------------------------------------------------------------
// Qwen: understand the request (intent only, no coordinates)
// ------------------------------------------------------------

async function parseIntentWithQwen(prompt, onProgress) {
    const model = await loadQwen(onProgress);
    const names = Object.keys(SHAPES).join(", ");

    const system =
        `You parse walking-game drawing requests.\n` +
        `Return ONLY JSON with these keys:\n` +
        `  "shape": one of [${names}] that best matches the request\n` +
        `  "size": "small" | "medium" | "large"\n` +
        `  "pace": "relaxed" | "normal" | "brisk"\n` +
        `  "title": a fun challenge title, max 6 words\n` +
        `Defaults: size "large", pace "normal".\n\n` +
        `Example request: "a big heart but make it a chill walk"\n` +
        `Example output: {"shape":"heart","size":"large","pace":"relaxed","title":"The Slow Heart Stroll"}\n\n` +
        `Example request: "something pointy with five corners"\n` +
        `Example output: {"shape":"star","size":"large","pace":"normal","title":"Five Point Dash"}`;

    const output = await model(
        [
            { role: "system", content: system },
            { role: "user", content: `${prompt}\n/no_think` },
        ],
        { max_new_tokens: 80, do_sample: false }
    );

    const generated = output?.[0]?.generated_text;
    const text = Array.isArray(generated)
        ? generated[generated.length - 1]?.content ?? ""
        : generated ?? "";

    console.log("🤖 Qwen raw:", text);

    const parsed = extractJSON(text);

    const shape = String(parsed.shape ?? "").toLowerCase().trim();
    const size = String(parsed.size ?? "").toLowerCase();
    const pace = String(parsed.pace ?? "").toLowerCase();

    return {
        shape: SHAPES[shape] ? shape : null,
        size: SIZE_FACTOR[size] ? size : "large",
        pace: ["relaxed", "normal", "brisk"].includes(pace) ? pace : "normal",
        title: typeof parsed.title === "string" ? parsed.title.slice(0, 60) : null,
    };
}

// ------------------------------------------------------------
// Public API used by App.jsx
// ------------------------------------------------------------

export async function generateSpatialPlanWithQwen({
    prompt,
    travelMode,
    maxDistanceKm,
    maxTimeMinutes,
    onProgress,
}) {
    let intent = null;

    // 1) AI first
    try {
        intent = await parseIntentWithQwen(prompt, onProgress);
    } catch (err) {
        console.warn("Qwen failed, falling back to keywords:", err);
    }

    // 2) Keyword safety net
    const shape = intent?.shape ?? matchShapeByKeyword(prompt);

    if (!shape) {
        throw new Error(
            `Couldn't recognise that shape. Try one of: ${Object.keys(SHAPES).join(", ")}`
        );
    }

    const size = intent?.size ?? "large";
    const pace = intent?.pace ?? "normal";

    const { budgetKm, targetPerimeterM, speedKmh } = computeBudget({
        prompt,
        travelMode,
        maxDistanceKm,
        maxTimeMinutes,
        size,
        pace,
    });

    const plan = {
        shape_name: shape,
        title: intent?.title ?? `${shape} challenge`,
        points: SHAPES[shape](),
        rotation_degrees: 0,
        target_perimeter_m: targetPerimeterM,
        budget_km: budgetKm,
        speed_kmh: speedKmh,
        size,
        pace,
    };

    console.log("✅ Spatial plan:", plan);
    return plan;
}