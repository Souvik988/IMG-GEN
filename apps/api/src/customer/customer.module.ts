import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { characters, environmentPresets } from "@shotlin/database";
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
}

@Module({
  imports: [AuthModule],
  controllers: [CustomerController],
  providers: [ListingsService],
})
export class CustomerModule {}
