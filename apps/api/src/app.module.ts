import { Module } from "@nestjs/common";
import { InfrastructureModule } from "./infrastructure";
import { AuthModule } from "./auth/auth.module";
import { HealthModule } from "./health/health.module";
import { UploadsModule } from "./uploads/uploads.module";
import { CustomerModule } from "./customer/customer.module";
import { JobsModule } from "./jobs/jobs.module";
import { AdminModule } from "./admin/admin.module";

@Module({
  imports: [
    InfrastructureModule,
    AuthModule,
    HealthModule,
    UploadsModule,
    CustomerModule,
    JobsModule,
    AdminModule,
  ],
})
export class AppModule {}
