import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AdminService } from "./admin.service";
import {
  BudgetController,
  ModelsController,
  PromptsController,
  QualityRulesController,
  SettingsController,
  SkillsController,
  WorkflowController,
} from "./admin-config.controllers";
import {
  AdminCharactersController,
  AdminCostsController,
  AdminEnvironmentsController,
  AdminJobsController,
  AdminOverviewController,
} from "./admin-data.controllers";

@Module({
  imports: [AuthModule],
  controllers: [
    WorkflowController,
    ModelsController,
    PromptsController,
    SkillsController,
    QualityRulesController,
    BudgetController,
    SettingsController,
    AdminJobsController,
    AdminCostsController,
    AdminOverviewController,
    AdminCharactersController,
    AdminEnvironmentsController,
  ],
  providers: [AdminService],
})
export class AdminModule {}
