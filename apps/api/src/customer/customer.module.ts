import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { characters, environmentPresets, modelRegistry } from "@shotlin/database";
import { AuthGuard } from "../common";
import { AuthModule } from "../auth/auth.module";
import { DB, type ApiDb } from "../infrastructure";

@Injectable()
class ListingsService {
  constructor(@Inject(DB) private db: ApiDb) {}

  async listCharacters() {
    return this.db
      .select()
      .from(characters)
      .where(eq(characters.isEnabled, true))
      .orderBy(characters.sortOrder);
  }

  async listEnvironments() {
    return this.db
      .select()
      .from(environmentPresets)
      .where(eq(environmentPresets.isEnabled, true))
      .orderBy(environmentPresets.sortOrder);
  }

  /** Image-generation models a customer may explicitly choose between. Only the fields safe to show outside admin. */
  async listImageModels() {
    const rows = await this.db
      .select({ id: modelRegistry.id, name: modelRegistry.name, notes: modelRegistry.notes })
      .from(modelRegistry)
      .where(and(eq(modelRegistry.role, "image_generator"), eq(modelRegistry.isEnabled, true)));
    return rows;
  }
}

@Controller("/customer")
@UseGuards(AuthGuard)
class CustomerController {
  constructor(private service: ListingsService) {}

  @Get("/characters")
  listCharacters() {
    return this.service.listCharacters();
  }

  @Get("/environments")
  listEnvironments() {
    return this.service.listEnvironments();
  }

  @Get("/models")
  listImageModels() {
    return this.service.listImageModels();
  }
}

@Module({
  imports: [AuthModule],
  controllers: [CustomerController],
  providers: [ListingsService],
})
export class CustomerModule {}
