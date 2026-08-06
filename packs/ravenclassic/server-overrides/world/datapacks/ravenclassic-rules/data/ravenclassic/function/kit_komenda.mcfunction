# Wykonywane jako gracz, który użył /trigger rc_kit.
scoreboard players set @s rc_kit 0
scoreboard players set @s rc_cd 1800
starterkit give @s Start
tellraw @s {"text":"Wyprawka wydana. Następna za 30 minut.","color":"gray"}
