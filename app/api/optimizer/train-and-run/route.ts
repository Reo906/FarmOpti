export async function POST() {
  return Response.json(
    {
      error:
        "Training and re-optimisation need the local Node pipeline. Run npm run dev and upload history.csv from the dashboard, or run npm run optimizer:train-and-run.",
    },
    { status: 503 },
  );
}
