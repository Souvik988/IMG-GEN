import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "./config";

export type Storage = ReturnType<typeof createStorage>;

export function createStorage(config: AppConfig) {
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
  });

  return {
    uploadsBucket: config.S3_BUCKET_UPLOADS,
    outputsBucket: config.S3_BUCKET_OUTPUTS,

    async putObject(
      bucket: string,
      key: string,
      body: Buffer,
      contentType: string,
    ): Promise<void> {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    async getObject(bucket: string, key: string): Promise<Buffer> {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw new Error(`Empty object: ${bucket}/${key}`);
      return Buffer.from(bytes);
    },

    async headObject(
      bucket: string,
      key: string,
    ): Promise<{ contentLength: number; contentType?: string } | null> {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          contentLength: res.ContentLength ?? 0,
          contentType: res.ContentType,
        };
      } catch {
        return null;
      }
    },

    async deleteObject(bucket: string, key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    /** Presigned URL for browser → storage direct upload. */
    async presignPut(
      bucket: string,
      key: string,
      contentType: string,
      expiresIn = 900,
    ): Promise<string> {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        { expiresIn },
      );
    },

    /** Presigned URL for downloading/viewing an asset. */
    async presignGet(bucket: string, key: string, expiresIn = 3600): Promise<string> {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn },
      );
    },
  };
}
