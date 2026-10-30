import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * The identity (rarity, scope and metric) of every published character and goal,
 * so a later export cannot silently redefine one.
 */
@Entity({ name: "content_identities" })
export class ContentIdentity {
  @PrimaryColumn({ type: "varchar", length: 191 })
  kind: string;
  @PrimaryColumn({ type: "varchar", length: 64 })
  id: string;
  @Column({ type: "varchar", length: 191, nullable: true })
  identity: string | null;
}
