# Cloud Run Jobs HTTP Scraper Trial

This trial runs the experimental HTTP scraper only. It does not upload to R2 and does not replace the current Selenium scheduler.

## Goal

1. Build a small HTTP-only container.
2. Run it as a Cloud Run Job.
3. Measure actual job duration, CPU, and memory settings.
4. Estimate whether a 5-minute schedule fits the Cloud Run free tier.


## Current OneDrive Limitation

The HTTP Cloud Run trial intentionally excludes OneDrive Web UI upload.

Current code paths using OneDrive Web UI are browser/Selenium dependent:

- Daily GBFS CSV/JSON upload from `check_and_run_daily_gbfs()`.
- Daily merged battery Parquet upload from `merge_and_upload_daily_logs()`.
- Self-replacement history upload from `sync_self_replacement_history_to_onedrive()`.
- Manual/historical merge upload commands.

The 5-minute raw battery CSV upload is currently skipped in `main.py`, so the core 5-minute map refresh can be moved independently if it writes dashboard artifacts to R2. Full cloud migration still needs a non-browser replacement for OneDrive backup, such as Microsoft Graph upload, R2 archival, or leaving the daily backup on the existing Windows PC until replaced.

## Prerequisites

- Google Cloud project with billing enabled.
- `gcloud` authenticated in Cloud Shell or a local terminal.
- Required APIs enabled:
  - Cloud Build
  - Artifact Registry
  - Cloud Run
  - Secret Manager
  - Cloud Scheduler, only when scheduling later

```bash
gcloud services enable \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com
```

## Variables

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="asia-northeast1"
export REPOSITORY="dbs"
export IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/dbs-http-job:latest"
export JOB_NAME="dbs-http-experiment"

gcloud config set project "$PROJECT_ID"
```

## Artifact Registry

```bash
gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker \
  --location="$REGION" \
  --description="DBS scraper containers"
```

If the repository already exists, the command can fail harmlessly.

## Secrets

Create secrets once. Do not commit the values.

```bash
printf '%s' 'YOUR_WORKER_ACCOUNT' | gcloud secrets create dbs-worker-account --data-file=-
printf '%s' 'YOUR_WORKER_PASSWORD' | gcloud secrets create dbs-worker-password --data-file=-
printf '%s' 'YOUR_WORKER_TOP_PAGE' | gcloud secrets create dbs-worker-top-page --data-file=-
```

If a secret already exists, add a new version instead:

```bash
printf '%s' 'NEW_VALUE' | gcloud secrets versions add dbs-worker-account --data-file=-
```

Grant the runtime service account access. This example uses the default Compute Engine service account.

```bash
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export RUN_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

for SECRET in dbs-worker-account dbs-worker-password dbs-worker-top-page; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:$RUN_SA" \
    --role="roles/secretmanager.secretAccessor"
done
```

## Build

From the repository root:

```bash
gcloud builds submit \
  --config cloudbuild.http-job.yaml \
  --substitutions _IMAGE="$IMAGE" \
  .
```

## Create The Trial Job

Use a small CPU allocation first. Cloud Run bills job resources with a minimum of 1 minute per task, so this setting is important for the free-tier estimate.

```bash
gcloud run jobs create "$JOB_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --tasks 1 \
  --max-retries 0 \
  --task-timeout 300s \
  --cpu 0.25 \
  --memory 512Mi \
  --set-secrets DBS_WORKER_ACCOUNT=dbs-worker-account:latest,DBS_WORKER_PASSWORD=dbs-worker-password:latest,DBS_WORKER_TOP_PAGE=dbs-worker-top-page:latest
```

If the job already exists, update it:

```bash
gcloud run jobs update "$JOB_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --tasks 1 \
  --max-retries 0 \
  --task-timeout 300s \
  --cpu 0.25 \
  --memory 512Mi \
  --set-secrets DBS_WORKER_ACCOUNT=dbs-worker-account:latest,DBS_WORKER_PASSWORD=dbs-worker-password:latest,DBS_WORKER_TOP_PAGE=dbs-worker-top-page:latest
```

## Execute Manually

```bash
gcloud run jobs execute "$JOB_NAME" --region "$REGION" --wait
```

Expected output in logs:

```text
[HTTP Experiment] areas: 6
[HTTP Experiment] total rows: ...
```

## Get Duration From Logs

Open Cloud Run > Jobs > dbs-http-experiment > Executions in the Console, or inspect logs:

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="dbs-http-experiment"' \
  --limit 50 \
  --format='value(timestamp,textPayload)'
```

For free-tier estimate, use Cloud Run's charged minimum of 60 seconds per execution unless the actual execution is longer.

## 5-Minute Schedule Estimate

5-minute schedule:

- 288 executions/day
- about 8,640 executions/month at 30 days

Charged seconds per month:

```text
charged_seconds = executions_per_month * max(actual_seconds, 60)
```

For the initial trial setting:

```text
vCPU-seconds = charged_seconds * 0.25
GiB-seconds  = charged_seconds * 0.5
```

If every execution is charged at the 60-second minimum:

```text
charged_seconds = 8,640 * 60 = 518,400
vCPU-seconds    = 518,400 * 0.25 = 129,600
GiB-seconds     = 518,400 * 0.5 = 259,200
```

This is below the Cloud Run free tier of 240,000 vCPU-seconds and 450,000 GiB-seconds per month in Tier 1 regions, before considering any other Cloud Run usage in the same billing account.

## Scheduling Later

Do not schedule until several manual executions are stable.

A scheduler can invoke the Cloud Run Jobs Run API every 5 minutes. Create a dedicated service account for this in production, then grant it permission to run the job.

```bash
export SCHEDULER_SA="dbs-scheduler@$PROJECT_ID.iam.gserviceaccount.com"
gcloud iam service-accounts create dbs-scheduler --display-name="DBS scheduler"

gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
  --region "$REGION" \
  --member="serviceAccount:$SCHEDULER_SA" \
  --role="roles/run.developer"

gcloud scheduler jobs create http dbs-http-every-5-min \
  --location="$REGION" \
  --schedule="*/5 * * * *" \
  --time-zone="Asia/Tokyo" \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/$JOB_NAME:run" \
  --http-method=POST \
  --oauth-service-account-email="$SCHEDULER_SA"
```

Keep the current Windows Task Scheduler/Selenium production path running until the HTTP job has matched production output over enough samples.